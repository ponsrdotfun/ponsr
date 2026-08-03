import { ethers } from 'ethers';

/**
 * ⚠️ UPDATE 2026-07-30 — the official Pons v2 docs are now known, and this placeholder is
 * wrong in every parameter. See `docs/pons-v2-findings.md` for the full record. Short version:
 *
 *   v2 actual:  launchToken(TokenParams params, uint256 launchConfigId, address pairToken)
 *                 payable returns (address token, address curve)
 *
 * TokenParams is a struct (name, symbol, logo, description, Socials, creatorFeeRecipient,
 * creatorTaxBps, buybackEnabled, expectedEconomics). There is NO devBuyAmount parameter, no
 * feeWallet, and no metadataURI — logo/description travel as calldata strings, so no IPFS
 * step is needed. The emitted event is also different from the one assumed below.
 *
 * This file is NOT updated to v2 on purpose: the v2 factory is not deployed and v2 is
 * unaudited, so there is no address to call and nothing to test against. v1 remains what is
 * live. Decide which version the bot targets (master doc, open question #17) before rewriting.
 *
 * ⚠️ CRITICAL TODO BEFORE PHASE 1 TESTNET RUNS ⚠️
 *
 * The ABI fragment below is a BEST-EFFORT placeholder, not a verified interface. Per Part 2
 * and Part 7 of the master doc, the real Pons factory ABI has never been directly pulled --
 * only the function name (`launchToken`) was confirmed indirectly via PonsShare's public
 * documentation. The exact parameter list, order, and types below are informed guesses based
 * on comparable launchpad factories (Doppler/Clanker-style patterns) and must be verified
 * against the real, verified contract before this encoder is trusted with a single real
 * transaction. See action-checklist.md item 1:
 *
 *   curl "https://api.blockscout.com/4663/api/v2/smart-contracts/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB?apikey=$BLOCKSCOUT_API_KEY"
 *
 * Once you have the real ABI, replace PONS_FACTORY_ABI_FRAGMENT below with the actual
 * `launchToken` (or whatever it turns out to be named) entry, and update
 * buildLaunchCalldata()'s argument construction to match the real parameter order/types.
 * Everything else in this file (the devBuyAmount=0 enforcement, the fee-wallet-from-splitter
 * wiring, the value-transfer handling) is structural and should not need to change.
 */
export const PONS_FACTORY_ABI_FRAGMENT = [
  'function launchToken(string name, string symbol, string metadataURI, address creatorWallet, address feeWallet, uint256 devBuyAmount) payable returns (address token, address pool)',
  'event TokenLaunched(address indexed token, address indexed pool, address indexed creator, string name, string symbol)',
  'function creationFee() view returns (uint256)',
];

export interface LaunchParams {
  tokenName: string;
  tokenSymbol: string;
  /** IPFS or other metadata URI. Empty string if no image/description provided -- confirm
   * against the real ABI whether Pons expects a URI here or separate calldata fields for
   * image/description/socials individually (see Part 1 §3 metadata flow discussion). */
  metadataURI: string;
  /** The end recipient of `creatorWallet` attribution on-chain. Per the fee-splitter design
   * (Part 8), this should be the per-launch FeeSplitter contract address, NOT the user's raw
   * wallet -- the splitter is what actually forwards 95% to the user. */
  creatorWallet: string;
  /** feeWallet and creatorWallet are the same address in this design (the splitter) --
   * kept as a separate field because the real ABI may or may not merge these two roles;
   * verify once the real ABI is in hand. */
  feeWallet: string;
}

/**
 * Builds the calldata + value for a launchToken() call. devBuyAmount is HARDCODED to 0 here,
 * not merely defaulted -- per Part 8/11, this must never be silently nonzero. If a future,
 * deliberate decision is made to support dev-buy, that should be a separate, explicitly-named
 * function so it's never accidentally reachable from the default launch path.
 */
export function buildLaunchCalldata(params: LaunchParams, creationFeeWei: bigint): {
  data: string;
  value: bigint;
} {
  const iface = new ethers.Interface(PONS_FACTORY_ABI_FRAGMENT);

  const DEV_BUY_AMOUNT_WEI = 0n; // See Part 8/11: must stay 0 unless deliberately overridden.

  const data = iface.encodeFunctionData('launchToken', [
    params.tokenName,
    params.tokenSymbol,
    params.metadataURI,
    params.creatorWallet,
    params.feeWallet,
    DEV_BUY_AMOUNT_WEI,
  ]);

  return { data, value: creationFeeWei };
}

/** Decodes the TokenLaunched event out of a transaction receipt's logs, so the deployed
 * token address is always read from the chain's own event log (per Part 1 §4.6's
 * requirement to never assume/derive the address any other way). */
export function extractLaunchedTokenAddress(logs: readonly ethers.Log[]): string | null {
  const iface = new ethers.Interface(PONS_FACTORY_ABI_FRAGMENT);
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === 'TokenLaunched') {
        return parsed.args.token as string;
      }
    } catch {
      continue; // not the event we're looking for, or from a different contract
    }
  }
  return null;
}
