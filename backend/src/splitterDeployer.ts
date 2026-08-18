import { ethers } from 'ethers';
import feeSplitterArtifact from './feeSplitterArtifact.json';
import { TreasurySigner } from './treasurySigner';
import { config } from './config';

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
  // around regular calls (to + data + value); for a raw-key signer this still works fine
  // with `to` omitted, since ethers treats an unset/empty `to` as contract creation. When
  // Turnkey's real signer is wired up (Phase 3 TODO in treasurySigner.ts), confirm its
  // policy scope explicitly allows a null-`to` contract-creation transaction, since the
  // policy is otherwise scoped to calling the Pons factory address specifically -- contract
  // deployment is a distinct, deliberate exception to that scoping and should be reviewed
  // as such, not assumed to fall under the same policy automatically.
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
