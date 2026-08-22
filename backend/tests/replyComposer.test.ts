import {
  composeRejectionReply,
  composeSuccessReply,
  composeOnChainFailureReply,
} from '../src/replyComposer';
import { RejectionReason } from '../src/types';

/**
 * The replies, which are the only part of this bot most people will ever see.
 *
 * `composeSuccessReply`'s link behaviour is tested in xClient.test.ts, where it belongs:
 * that is a pricing decision about X's API, not a wording one. What had no tests at all
 * was the rejection path -- fourteen branches, several of which exist specifically to
 * withhold something.
 *
 * That is the risk worth pinning. A rejection reply is published, unprompted, to a
 * stranger's timeline, and the `detail` string it is handed comes from the validator and
 * the orchestrator: balances, error messages, internal state. Most branches are written
 * to ignore it. The `default` branch echoes it verbatim.
 */

/** Every reason in the union. Listed by hand: if someone adds one and does not add it
 *  here, the exhaustiveness test below fails, which is the point. */
const ALL_REASONS: RejectionReason[] = [
  'MISSING_REQUIRED_FIELD',
  'NOT_LAUNCH_INTENT',
  'LOW_CONFIDENCE',
  'FAILED_SANITIZATION',
  'RATE_LIMIT_USER',
  'DAILY_SPEND_CAP_REACHED',
  'ACCOUNT_TOO_NEW',
  'INSUFFICIENT_FOLLOWERS',
  'FEE_EXCEEDS_CEILING',
  'TREASURY_EXHAUSTED',
  'LAUNCHPAD_UNAVAILABLE',
  'PAIR_ASSET_UNAVAILABLE',
  'PARSER_UNAVAILABLE',
  'DUPLICATE_TWEET',
];

/** Stands in for whatever the validator actually passes. Deliberately shaped like the
 *  things that would be embarrassing in public: a balance, a key name, a provider error. */
const CANARY =
  'hot wallet 0x08e0 holds 3141592653589793 wei, reserve 2000000000000000, OPENROUTER 402 insufficient credit';

describe('composeRejectionReply', () => {
  it('answers every reason without falling through to an unwritten branch', () => {
    for (const reason of ALL_REASONS) {
      const text = composeRejectionReply(reason, CANARY);
      // Silence is a valid answer for two of them; a generic apology is not.
      expect(typeof text).toBe('string');
      expect(text).not.toMatch(/unknown reason/i);
    }
  });

  /**
   * The one that matters.
   *
   * `TREASURY_EXHAUSTED` carries the hot wallet's balance and gas reserve in `detail`,
   * for the operator's alert. Echoing it to the person who tweeted would hand an
   * attacker a live treasury readout, one rejected tweet at a time -- and they choose
   * when the tweets arrive, so they choose the sampling rate.
   *
   * The balance is public on chain. A polling endpoint for it, addressed to whoever asks,
   * is not.
   */
  it('never leaks the operator detail into a public reply', () => {
    for (const reason of ALL_REASONS) {
      // PAIR_ASSET_UNAVAILABLE is the deliberate exception: its detail is the approved
      // asset list, built from the chain, and naming it is the whole point -- otherwise
      // the person retries the same asset and gets the same refusal.
      if (reason === 'PAIR_ASSET_UNAVAILABLE') continue;
      const text = composeRejectionReply(reason, CANARY);
      expect(text).not.toContain('3141592653589793');
      expect(text).not.toContain('OPENROUTER');
      expect(text).not.toContain(CANARY);
    }
  });

  it('says nothing at all for the two cases that must stay silent', () => {
    // Not a launch request, and a duplicate delivery. Replying to either is noise on
    // somebody's timeline for an event that did not happen.
    expect(composeRejectionReply('NOT_LAUNCH_INTENT', CANARY)).toBe('');
    expect(composeRejectionReply('DUPLICATE_TWEET', CANARY)).toBe('');
  });

  it('names the approved assets when the pairing is the problem', () => {
    const detail = 'approved right now: ETH, AAPL, NVDA.';
    expect(composeRejectionReply('PAIR_ASSET_UNAVAILABLE', detail)).toContain(detail);
  });

  it('still answers when the pairing detail is missing', () => {
    const text = composeRejectionReply('PAIR_ASSET_UNAVAILABLE');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/nothing was charged/i);
  });

  /**
   * Whose fault it was, stated accurately.
   *
   * Three of these refusals are not the user's doing and not chargeable to them. Saying
   * so is the difference between a refusal someone accepts and one they argue with.
   */
  it('makes clear that upstream and treasury pauses cost the user nothing', () => {
    for (const reason of ['TREASURY_EXHAUSTED', 'LAUNCHPAD_UNAVAILABLE'] as RejectionReason[]) {
      expect(composeRejectionReply(reason)).toMatch(/nothing was charged/i);
    }
  });

  it('does not blame pons or promise a time it cannot keep', () => {
    const text = composeRejectionReply('LAUNCHPAD_UNAVAILABLE');
    expect(text).not.toMatch(/\bPons\b/); // lowercase in user-facing copy, always
    expect(text).not.toMatch(/(broken|down|abandoned|fault)/i);
    expect(text).not.toMatch(/\b(minutes|hours|tomorrow morning|shortly today)\b/i);
  });

  it('tells someone what to actually type when the parse was incomplete', () => {
    // A refusal that does not say what would have worked is a dead end.
    for (const reason of ['MISSING_REQUIRED_FIELD', 'LOW_CONFIDENCE'] as RejectionReason[]) {
      const text = composeRejectionReply(reason);
      expect(text).toMatch(/name/i);
      expect(text).toMatch(/symbol/i);
    }
  });
});

describe('composeSuccessReply', () => {
  const base = {
    tokenName: 'Moon Coin',
    tokenSymbol: 'MOON',
    tokenAddress: '0x1234567890123456789012345678901234567890',
    txHash: '0xabc',
  };

  /**
   * Through the direct path the TREASURY is the on-chain deployer; the user receives the
   * creator share through the splitter. The reply must not imply otherwise -- it is the
   * one artefact a user keeps, and a claim about who deployed a token is checkable by
   * anyone and wrong forever if we word it loosely.
   */
  it('never claims the user deployed the token', () => {
    const text = composeSuccessReply({ ...base, includeLink: false });
    expect(text).not.toMatch(/you (deployed|launched|created|own)/i);
    expect(text).not.toMatch(/your (token|contract) (was )?deployed by you/i);
  });

  it('claims no affiliation with pons', () => {
    const text = composeSuccessReply({ ...base, includeLink: true, siteBaseUrl: 'https://ponsr.fun' });
    expect(text).not.toMatch(/official|partner|endorsed|affiliated|in partnership/i);
  });

  /**
   * The address-free form exists for X's 7-day crypto-address block, and it used to
   * contain an address.
   *
   * It linked to `/token/<address>`, so the retry carried a full 0x address in a reply
   * sent BECAUSE the previous one was rejected for containing a 0x address. The filter
   * reads the post text, and the URL is post text. Same refusal, nothing delivered, at
   * $0.200 rather than $0.015 -- and the degraded-reply alert fired regardless, so a
   * fallback that could not work looked like one that did.
   */
  it('contains no address at all when addresses are omitted', () => {
    const text = composeSuccessReply({ ...base, omitAddresses: true, siteBaseUrl: 'https://ponsr.fun' });
    expect(text).not.toContain(base.tokenAddress);
    expect(text).not.toContain(base.txHash);
    // The real assertion: nothing address-shaped anywhere, including inside a URL.
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('still says where to find the token when addresses are omitted', () => {
    // A reply announcing a token without saying where it is would not be worth sending.
    const text = composeSuccessReply({ ...base, omitAddresses: true, siteBaseUrl: 'https://ponsr.fun' });
    expect(text).toContain('https://ponsr.fun/explore');
    expect(text).toContain('MOON');
  });

  // Keyed on the address, never the symbol: two tokens called PONSR were launched within
  // a day on 2026-08-12, and a symbol link resolves to whichever the site happens to
  // match. Sending someone a link to a stranger's token is worse than sending none.
  it('keys the link on the contract address, not the symbol', () => {
    const text = composeSuccessReply({ ...base, includeLink: true, siteBaseUrl: 'https://ponsr.fun' });
    expect(text).toContain(`/token/${base.tokenAddress}`);
    expect(text).not.toContain('/token/MOON');
  });
});

describe('composeOnChainFailureReply', () => {
  it('says what failed and that a human will look', () => {
    const text = composeOnChainFailureReply({ reasonSummary: 'the transaction reverted' });
    expect(text).toContain('the transaction reverted');
    expect(text).toMatch(/flagged for review/i);
  });

  it('includes the balance only when the caller deliberately passes one', () => {
    const withBalance = composeOnChainFailureReply({
      reasonSummary: 'out of gas',
      walletAddress: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      walletBalanceWei: 12345n,
    });
    expect(withBalance).toContain('12345');

    const without = composeOnChainFailureReply({ reasonSummary: 'out of gas' });
    expect(without).not.toContain('12345');
    expect(without).not.toMatch(/0x08e0/);
  });
});
