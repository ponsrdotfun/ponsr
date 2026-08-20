import { ethers } from 'ethers';
import feeSplitterArtifact from './feeSplitterArtifact.json';
import { TreasurySigner } from './treasurySigner';
import { config } from './config';
import { PonsDeployment, executableDeployment } from './deployments';

/**
 * Deploys one FeeSplitter per launch (see contracts/FeeSplitter.sol's header comment for why
 * this is a per-launch deployment rather than a shared singleton -- keeps blast radius
 * contained to a single token's fees). The bytecode/ABI here are loaded from
 * feeSplitterArtifact.json, which is copied directly from the output of
 * `node compile-all.js` in the contracts workspace -- see contracts-test/README for how to
 * regenerate it if FeeSplitter.sol is ever changed. Keeping this as a checked-in JSON file
 * (rather than compiling Solidity at backend runtime) means the backend has no Solidity
 * toolchain dependency at all.
 */
/**
 * Which splitter a launch needs depends on how that factory pays.
 *
 * v1 **pushes**: the locker transfers fees straight to the recipient, so a contract
 * that can move ERC20 out again is enough.
 *
 * v2 **credits**: fees sit in `PonsV2FeeEscrow` and are collected by calling
 * `claimToken`, which pays `msg.sender`. There is no way to claim on another
 * address's behalf — so a plain `FeeSplitter` named as `creatorFeeRecipient` on a v2
 * launch would be credited correctly and forever, with no transaction in existence
 * able to move the money. Deploying the wrong one here is not a degraded launch, it
 * is a launch whose fees are stranded from the first trade.
 */
function splitterArtifact(): { abi: any; bytecode: string; name: string } {
  const wantV2 = config.PONS_FACTORY_VERSION === 'v2';
  const name = wantV2 ? 'FeeSplitterV2' : 'FeeSplitter';
  const art = (feeSplitterArtifact as any)[name];
  if (!art?.bytecode) {
    // Refuse rather than silently fall back to the other one. Falling back is how the
    // 2026-08-04 incident happened: a launch went out against a splitter nobody
    // intended, and its fees are unreachable to this day.
    throw new Error(
      `feeSplitterArtifact.json has no ${name}. Run \`node compile-all.js\` from the repo root.`
    );
  }
  return { abi: art.abi, bytecode: art.bytecode, name };
}

/**
 * Which escrow a splitter for this deployment must be built against.
 *
 * Comes from the registry rather than configuration, because the escrow and the
 * factory are not independently settable facts: each pons deployment credits its own
 * escrow, and a splitter is bound to one at construction and cannot be repointed.
 */
export function splitterEscrowFor(deployment: PonsDeployment = executableDeployment()): string {
  return deployment.feeEscrow;
}

/**
 * Refuses to continue unless the chain agrees with the manifest.
 *
 * The manifest is a claim; `factory.feeEscrow()` is the fact. They can disagree in
 * exactly one interesting way -- somebody edits an address, or pons migrates again --
 * and the consequence is not a failed launch but a successful one whose fees are
 * unreachable forever. The escrow is immutable in the splitter, escrow claims pay
 * `msg.sender`, and no `claimFor` exists, so nothing recovers them afterwards: not
 * the treasury, not the creator, not pons.
 *
 * Called before the splitter is deployed, so a mismatch costs nothing at all.
 */
export function assertEscrowMatches(deployment: PonsDeployment, liveEscrow: string): void {
  const expected = deployment.feeEscrow.toLowerCase();
  const actual = (liveEscrow ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(actual) || /^0x0+$/.test(actual)) {
    throw new Error(
      `refusing to deploy a splitter: ${deployment.id} reported an unusable fee escrow "${liveEscrow}". ` +
        `Expected ${deployment.feeEscrow}.`
    );
  }
  if (expected !== actual) {
    throw new Error(
      `refusing to deploy a splitter: fee escrow mismatch for ${deployment.id}. ` +
        `Manifest says ${deployment.feeEscrow}, the factory reports ${liveEscrow}. ` +
        'A splitter built against the wrong escrow holds creator fees nothing can ever claim.'
    );
  }
}

export interface SplitterDeployResult {
  splitterAddress: string;
  deployTxHash: string;
}

/**
 * NOTE on signer: in the current design, the FeeSplitter is deployed as its own transaction,
 * separate from the launchToken() call. This uses the same treasury signer (it's a small,
 * cheap deployment -- a few thousand gas on a sub-cent-gas chain, see Part 2's confirmed gas
 * costs). An alternative worth considering during Phase 3 implementation: deploying the
 * splitter via CREATE2 from within the same transaction as the launch itself, if the real
 * Pons ABI supports a pre-computed feeWallet address being passed in before it exists on-
 * chain yet. That's an optimization, not a correctness requirement -- the two-transaction
 * approach here is simpler to reason about and test, and is the right default until real
 * gas-cost data from testnet suggests otherwise.
 */
export async function deploySplitter(
  signer: TreasurySigner,
  creatorWallet: string,
  treasuryWallet: string,
  tokenAddressPlaceholder: string
): Promise<SplitterDeployResult> {
  const { abi, bytecode, name } = splitterArtifact();
  const factory = new ethers.ContractFactory(abi, bytecode);

  // v2's splitter takes the escrow address as a fourth argument, and it is immutable:
  // a splitter that could be repointed later is a splitter whose fees could be
  // redirected after a creator has agreed to the terms.
  const deployTx =
    name === 'FeeSplitterV2'
      ? await factory.getDeployTransaction(
          creatorWallet,
          treasuryWallet,
          tokenAddressPlaceholder,
          config.PONS_V2_FEE_ESCROW_ADDRESS
        )
      : await factory.getDeployTransaction(creatorWallet, treasuryWallet, tokenAddressPlaceholder);

  // Contract-creation transactions have no `to` field. TreasurySigner's interface is shaped
  // around regular calls (to + data + value); ethers treats an unset `to` as contract
  // creation, so this works for both signers.
  //
  // The Turnkey policy allows it explicitly, and that was the point: the policy is
  // otherwise scoped to the pons factory addresses, and a contract creation matches none
  // of them. Confirmed live by scripts/turnkey-verify-policy.ts, which asserts contract
  // creation ALLOWED alongside an arbitrary destination denied -- without that exception
  // a launch would half-complete, splitter deployed and paid for, token never created.
  const sent = await signer.sendTransaction({
    to: '',
    data: deployTx.data as string,
    value: 0n,
  });

  const receipt = await sent.wait();
  if (!receipt || !receipt.contractAddress) {
    throw new Error('Splitter deployment did not produce a contract address -- check receipt status.');
  }

  return { splitterAddress: receipt.contractAddress, deployTxHash: sent.hash };
}
