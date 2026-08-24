import { ethers } from 'ethers';
import feeSplitterArtifact from './feeSplitterArtifact.json';
import type { TreasurySigner } from './treasurySigner';
import { PonsDeployment, executableDeployment } from './deployments';
import { assertDeploymentIdentity } from './deploymentIdentity';

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
export function splitterArtifactFor(
  deployment: PonsDeployment = executableDeployment()
): {
  abi: any;
  bytecode: string;
  deployedBytecode?: string;
  /** Where the constructor patches values into the runtime. See splitterVerifier.ts. */
  immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
  /** AST node id -> declared name, so each offset can be bound to an expected value. */
  immutableNames?: Record<string, string>;
  name: string;
} {
  // From the deployment's FEE MODEL, not from `config.PONS_FACTORY_VERSION`.
  //
  // The flag answers "which factory does this bot launch through by default". This
  // question is "does the deployment this launch is going to credit an escrow", and the
  // two can disagree -- a v1 rollback with the flag still v2, or an injected v2 target
  // while the flag says v1.
  //
  // Getting it wrong is not a degraded launch. A plain FeeSplitter named as
  // creatorFeeRecipient on an escrow-crediting deployment is credited correctly and
  // forever, with no transaction in existence able to move the money: the escrow pays
  // `msg.sender` and a v1 splitter cannot call it at all.
  const name = deployment.feeModel === 'escrow-credit' ? 'FeeSplitterV2' : 'FeeSplitter';
  const art = (feeSplitterArtifact as any)[name];
  if (!art?.bytecode) {
    // Refuse rather than silently fall back to the other one. Falling back is how the
    // 2026-08-04 incident happened: a launch went out against a splitter nobody
    // intended, and its fees are unreachable to this day.
    throw new Error(
      `feeSplitterArtifact.json has no ${name}. Run \`node compile-all.js\` from the repo root.`
    );
  }
  // deployedBytecode is what actually ends up AT the address, and is what makes a
  // deployed splitter's identity checkable rather than merely plausible. Optional so an
  // artifact compiled before it was emitted still loads, and the verifier says so instead
  // of treating its absence as a pass.
  return {
    abi: art.abi,
    bytecode: art.bytecode,
    deployedBytecode: art.deployedBytecode,
    immutableReferences: art.immutableReferences,
    immutableNames: art.immutableNames,
    name,
  };
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
  tokenAddressPlaceholder: string,
  /**
   * Optional, and the reason it exists is timing.
   *
   * `readCurrentReadiness` already verifies identity -- but readiness and this deploy
   * are two separate moments, and only one of them spends gas. A factory upgraded, an
   * RPC swapped to another chain, an ABI regenerated: all of it lands in the window
   * between, and the splitter is the first DURABLE artifact this flow creates. A
   * splitter bound to a factory that has since moved is not a wasted fee; it is a
   * contract that may be handed a creator's fees and be unable to claim them.
   *
   * Pass a provider and the check runs here too, immediately before the bytes go out.
   * Omit it and the caller is asserting that nothing could have changed since readiness
   * -- true in the unit tests, which have no chain at all.
   */
  provider?: ethers.Provider,
  /** The deployment this splitter is being built for. Defaults to the executable one;
   *  the orchestrator passes the SELECTED target's, which can differ under rollback. */
  deployment: PonsDeployment = executableDeployment(),
  /**
   * Lifecycle hooks, because this function broadcasts internally.
   *
   * A caller needing a durable record of an irreversible action cannot obtain one from
   * outside a function that sends AND waits before it returns: a crash anywhere in here
   * loses the hash entirely, and the canary journal was blind to exactly this. The canary
   * journals through these. Production passes none and behaves exactly as before.
   */
  hooks?: {
    /** Exact initcode, before anything can be broadcast. */
    onPlanned?: (initcode: string) => void | Promise<void>;
    /** The hash, the instant send returns and before the receipt is awaited. */
    onSent?: (txHash: string) => void | Promise<void>;
    /**
     * Replaces the internal `sendTransaction` with a caller-supplied lifecycle.
     *
     * The canary supplies sign -> persist identity -> broadcast, so the transaction is
     * identifiable by canonical hash before any broadcast is reachable. Production supplies
     * nothing and keeps the previous single-call behaviour.
     *
     * It takes the initcode rather than a full request because a splitter deployment is a
     * contract creation: there is no destination, and inventing one to fit a uniform shape is
     * how a creation quietly becomes a call to an address.
     */
    sendVia?: (initcode: string) => Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt | null> }>;
    /** `status: null` means no receipt was seen — which is not a revert. */
    onReceipt?: (r: { status: number | null; contractAddress: string | null }) => void | Promise<void>;
  }
): Promise<SplitterDeployResult> {
  if (provider) {
    // Throws rather than returning a flag: after this function returns there is already
    // a durable side effect, so the refusal has to happen before anything is sent.
    await assertDeploymentIdentity(deployment, provider);
  }
  const { abi, bytecode, name } = splitterArtifactFor(deployment);
  const factory = new ethers.ContractFactory(abi, bytecode);

  // v2's splitter takes the escrow address as a fourth argument, and it is immutable:
  // a splitter that could be repointed later is a splitter whose fees could be
  // redirected after a creator has agreed to the terms.
  //
  // From the registry, never from configuration. This line read
  // `config.PONS_V2_FEE_ESCROW_ADDRESS` until 2026-08-20, whose default is the escrow
  // of the factory pons replaced. Everything around it had already been migrated, so
  // the launch would have succeeded -- the factory's escrow matched the registry, the
  // calldata was correct, the transaction confirmed -- and only the splitter would
  // have been bound to the wrong escrow. That is the failure with no recovery: fees
  // credited to an address the splitter cannot claim from, forever.
  const escrow = splitterEscrowFor(deployment);
  const deployTx =
    name === 'FeeSplitterV2'
      ? await factory.getDeployTransaction(
          creatorWallet,
          treasuryWallet,
          tokenAddressPlaceholder,
          escrow
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
  /**
   * The lifecycle, actually invoked.
   *
   * These three calls were declared in the signature and wired at the call site, and never
   * appeared here. A parameter existed, callbacks existed, and nothing connected them --
   * so the caller's journal recorded nothing, a crash after broadcast still lost the hash,
   * and a rerun could deploy a second permanent contract. Every test covering it built
   * journal rows by hand and never entered this function.
   *
   * Awaited, not fired and forgotten. The whole point is that the record exists BEFORE the
   * irreversible step, so a hook that fails must stop the lifecycle rather than be stepped
   * over: an unrecorded broadcast is exactly the state this is meant to prevent.
   */
  await hooks?.onPlanned?.(deployTx.data as string);

  /**
   * The window nothing could see, now closed by whoever owns the lifecycle.
   *
   * With `sendVia`, the identity is durable before this line returns and `onSent` has nothing
   * left to rescue -- the hash was written down before the bytes went out, not after. Without
   * it, behaviour is exactly as before: send, then record the hash, with the gap in between.
   */
  const sent = hooks?.sendVia
    ? await hooks.sendVia(deployTx.data as string)
    : await signer.sendTransaction({
        to: '',
        data: deployTx.data as string,
        value: 0n,
      });

  await hooks?.onSent?.(sent.hash);

  const receipt = await sent.wait();
  // Fires for every outcome including a missing receipt, because `status: null` is how the
  // caller keeps an ambiguous row blocking instead of recording a revert that never happened.
  await hooks?.onReceipt?.({
    status: receipt ? Number(receipt.status) : null,
    contractAddress: receipt?.contractAddress ?? null,
  });

  if (!receipt || !receipt.contractAddress) {
    throw new Error('Splitter deployment did not produce a contract address -- check receipt status.');
  }

  return { splitterAddress: receipt.contractAddress, deployTxHash: sent.hash };
}
