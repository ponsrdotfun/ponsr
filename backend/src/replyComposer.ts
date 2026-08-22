import { RejectionReason } from './types';
import { config } from './config';

/**
 * Every reply here follows the interface-writing guidance from the frontend-design skill even
 * though this is plain text, not UI: name things by what the user controls/recognizes, be
 * specific rather than clever, and for failures state exactly what happened and what to do
 * next -- modeled directly on the real Bankr failure-message example captured in Part 6
 * research ("you currently hold X ETH, which is not enough... please add more ETH to Y and
 * try again"), which is a good template precisely because it's concrete, not vague.
 */

/**
 * The success reply.
 *
 * The link to the token's page on ponsr.fun sits behind `REPLY_INCLUDE_LINK` because it is a
 * pricing decision, not a formatting one: X charges **$0.200 for a post containing a URL
 * against $0.015 without**. Thirteen times more, for one link. At a hundred launches a month
 * that is $20 against $1.50.
 *
 * Off by default so the cost is chosen rather than discovered on an invoice. Turning it on is
 * entirely reasonable -- traffic to the board may well be worth $18.50 a month -- but someone
 * should decide it. The contract address is included either way: it is what the recipient
 * actually needs, and it is not a URL.
 */
export function composeSuccessReply(params: {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  txHash: string;
  includeLink?: boolean;
  siteBaseUrl?: string;
  /** Drop the address and tx hash, carrying the site link instead. See the note below. */
  omitAddresses?: boolean;
}): string {
  const includeLink = params.includeLink ?? config.REPLY_INCLUDE_LINK;
  const base = params.siteBaseUrl ?? config.SITE_BASE_URL;

  // X refuses posts containing crypto addresses for the first 7 days after an app or token is
  // authenticated: "Crypto addresses are prohibited for the first 7 days after authentication."
  // (403, observed 2026-08-12 on a real launch). Both the token address and the transaction
  // hash trip it, and regenerating credentials appears to restart the window -- so the clock
  // tracks the credentials, not the account.
  //
  // The address-free form carries the link instead: a reply announcing a token without saying
  // where to find it is not worth sending. That costs $0.20 rather than $0.015, which is the
  // price of answering at all during the window.
  // The link is keyed on the contract address, never the symbol. Symbols come from whoever
  // tweets, so two people can claim the same one -- two tokens called PONSR were launched
  // within a day on 2026-08-12 -- and a symbol link then resolves to whichever the site
  // happens to match, or to nothing at all. Sending someone a link to a stranger's token is
  // worse than sending no link.
  const link = `${base}/token/${encodeURIComponent(params.tokenAddress)}`;

  if (params.omitAddresses) {
    // The board, NOT the token page.
    //
    // This used to send `${base}/token/${tokenAddress}` -- which contains a full 0x
    // address, in a reply whose entire reason for existing is that X rejected the last
    // one for containing a 0x address. The post text includes the URL, so the retry
    // almost certainly tripped the same filter: same refusal, no reply delivered, at
    // $0.200 instead of $0.015 because the retry carries a link. And the degraded-reply
    // alert fired either way, which made a fallback that could not work look like one
    // that did.
    //
    // Linking by symbol is not the alternative: symbols come from whoever tweets, two
    // tokens called PONSR were launched within a day on 2026-08-12, and a symbol link
    // resolves to whichever the site happens to match. Sending someone a stranger's
    // token is worse than making them look.
    //
    // So: the board, and the symbol in the text. They can find it, and nothing here is
    // an address.
    return [
      `${params.tokenName} ($${params.tokenSymbol}) is live.`,
      `Find it on the board: ${base}/explore`,
    ].join('\n');
  }

  const lines = [
    `${params.tokenName} ($${params.tokenSymbol}) is live.`,
    `Token: ${params.tokenAddress}`,
    `Tx: ${params.txHash}`,
  ];
  if (includeLink) lines.push(link);
  return lines.join('\n');
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
    case 'LAUNCHPAD_UNAVAILABLE':
      // The cause is on pons's side, so promising a specific timeframe would be a promise we
      // cannot keep. Say what is true: not your request, not chargeable, try later.
      return "The launchpad isn't accepting new launches right now. Nothing was charged to you -- this is upstream of us, so try again later.";
    case 'PAIR_ASSET_UNAVAILABLE':
      // Names what went wrong and what is available, because the alternative is
      // someone retrying the same asset and getting the same refusal. `detail`
      // carries the approved list, built from the chain rather than a copy here
      // that would go stale the moment pons approves anything.
      return detail
        ? `Can't pair a launch with that -- ${detail} Nothing was charged to you.`
        : "That pairing asset isn't available for launches. Nothing was charged to you.";
    case 'PARSER_UNAVAILABLE':
      // Silent, and deliberately so: the mention's claim is RELEASED on this path and the
      // sweep retries it. Replying would tell someone their request failed moments before
      // it succeeds on its own.
      //
      // It is listed explicitly rather than left to fall through, because the default
      // branch echoes `detail` -- and this reason's detail is the raw parser error. A
      // test proved it: the canary came back as
      // "Couldn't launch that one (hot wallet 0x08e0 holds 3141592653589793 wei, …
      // OPENROUTER 402 insufficient credit). Try again."
      // Nothing sends it today. Nothing had to; the wording was already written.
      return '';
    case 'DUPLICATE_TWEET':
      return ''; // Silent -- this is a retry/duplicate delivery, not a new user-facing event.
    default:
      // Reached only by a reason nobody has written a reply for. It says less than the
      // branches above on purpose: `detail` comes from the validator and the orchestrator
      // and carries balances, reserves and provider errors, and this reply is published
      // unprompted to a stranger's timeline. An attacker who can make the bot refuse can
      // choose how often they read it.
      //
      // The operator still gets the detail -- through the monitor, where it belongs.
      console.error(`[reply] no reply written for rejection reason; detail withheld: ${detail ?? '(none)'}`);
      return "Couldn't launch that one. This has been flagged for review -- try again shortly.";
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
