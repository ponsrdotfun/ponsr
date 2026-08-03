import { RejectionReason } from './types';

/**
 * Every reply here follows the interface-writing guidance from the frontend-design skill even
 * though this is plain text, not UI: name things by what the user controls/recognizes, be
 * specific rather than clever, and for failures state exactly what happened and what to do
 * next -- modeled directly on the real Bankr failure-message example captured in Part 6
 * research ("you currently hold X ETH, which is not enough... please add more ETH to Y and
 * try again"), which is a good template precisely because it's concrete, not vague.
 */

export function composeSuccessReply(params: {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  txHash: string;
}): string {
  return (
    `${params.tokenName} ($${params.tokenSymbol}) is live.\n` +
    `Token: ${params.tokenAddress}\n` +
    `Tx: ${params.txHash}`
  );
}

export function composeRejectionReply(reason: RejectionReason, detail?: string): string {
  switch (reason) {
    case 'NOT_LAUNCH_INTENT':
      // Deliberately no reply for this case -- see orchestrator.ts. Returning a string here
      // for completeness/testability, but the orchestrator should suppress sending it to
      // avoid bot noise on tweets that were never actually launch requests.
      return '';
    case 'MISSING_REQUIRED_FIELD':
    case 'LOW_CONFIDENCE':
      return "Couldn't catch both a name and a symbol for that one -- reply with something like \"name: Moon Coin, symbol: MOON\" and I'll launch it.";
    case 'FAILED_SANITIZATION':
      return "That name or symbol has characters I can't use. Stick to letters, numbers, and basic punctuation and try again.";
    case 'RATE_LIMIT_USER':
      return "You've hit today's launch limit for your account. Try again in 24h.";
    case 'DAILY_SPEND_CAP_REACHED':
      return "Launches are paused for today -- we've hit today's budget. Try again tomorrow.";
    case 'ACCOUNT_TOO_NEW':
      return "This account is too new to launch through the bot yet. Check back once it's had more time on X.";
    case 'INSUFFICIENT_FOLLOWERS':
      return "This account doesn't meet the minimum follower threshold to launch through the bot right now.";
    case 'FEE_EXCEEDS_CEILING':
      return 'Launches are paused -- the network fee just spiked above what we allow automatically. Try again shortly.';
    case 'TREASURY_EXHAUSTED':
      // The validator's `detail` for this reason quotes the hot wallet's balance and gas
      // reserve. That belongs in the operator's alert, not in a public reply -- so this case
      // is explicit rather than falling through to the default branch, which would echo it.
      // (The balance is readable on-chain by anyone, so this is not a secret; it is just not
      // something to hand an attacker a live readout of, one rejected tweet at a time.)
      return "Launches are paused while the treasury is topped up -- nothing was charged to you. Try again shortly and it'll go through.";
    case 'DUPLICATE_TWEET':
      return ''; // Silent -- this is a retry/duplicate delivery, not a new user-facing event.
    default:
      return `Couldn't launch that one (${detail ?? 'unknown reason'}). Try again.`;
  }
}

export function composeOnChainFailureReply(params: {
  reasonSummary: string;
  walletAddress?: string;
  walletBalanceWei?: bigint;
}): string {
  if (params.walletAddress && params.walletBalanceWei !== undefined) {
    return (
      `Launch failed: ${params.reasonSummary}. ` +
      `Treasury wallet ${params.walletAddress} currently holds ${params.walletBalanceWei.toString()} wei, ` +
      `which may not be enough to cover this. This has been flagged for review.`
    );
  }
  return `Launch failed: ${params.reasonSummary}. This has been flagged for review -- try again shortly.`;
}
