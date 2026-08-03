import { ethers } from 'ethers';
import feeSplitterArtifact from './feeSplitterArtifact.json';
import { TreasurySigner } from './treasurySigner';

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
const { abi, bytecode } = (feeSplitterArtifact as any).FeeSplitter;

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
  const factory = new ethers.ContractFactory(abi, bytecode);
  const deployTx = await factory.getDeployTransaction(creatorWallet, treasuryWallet, tokenAddressPlaceholder);

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
