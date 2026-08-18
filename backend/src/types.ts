/** Raw inbound mention event, shape-compatible with a twitterapi.io webhook payload. */
export interface InboundMention {
  tweetId: string;
  authorXUserId: string;
  authorHandle: string;
  text: string;
  createdAt: string; // ISO timestamp
  /** Set by the provider if this tweet is a reply continuing an earlier thread. */
  inReplyToTweetId?: string | null;
}

/** The structured intent extracted by the LLM parser. Never contains wallet/fee fields --
 * see docs/SECURITY-BOUNDARIES.md for why that's a hard architectural rule, not a convention. */
export interface ParsedIntent {
  isLaunchIntent: boolean;
  confidence: 'high' | 'medium' | 'low';
  tokenName: string | null;
  tokenSymbol: string | null;
  description: string | null;
  /** The asset the launch should be priced and traded in, exactly as the person
   *  typed it -- a symbol, a company name, or null when they did not ask.
   *
   *  Deliberately unresolved. The parser reads a tweet; it does not get to decide
   *  which assets pons has approved, and a model that "corrected" AAPL to something
   *  else would be choosing an asset nobody asked for. Resolution and approval are
   *  checked against the chain in pairTokens.ts. */
  pairWith: string | null;
}

export type RejectionReason =
  | 'MISSING_REQUIRED_FIELD'
  | 'NOT_LAUNCH_INTENT'
  | 'LOW_CONFIDENCE'
  | 'FAILED_SANITIZATION'
  | 'RATE_LIMIT_USER'
  | 'DAILY_SPEND_CAP_REACHED'
  | 'ACCOUNT_TOO_NEW'
  | 'INSUFFICIENT_FOLLOWERS'
  | 'FEE_EXCEEDS_CEILING'
  /** The hot wallet cannot fund another launch (Part 5 mitigation #7). Distinct from
   *  DAILY_SPEND_CAP_REACHED: that one is a policy pause with funds still available,
   *  this one is the wallet actually being out of money. */
  | 'TREASURY_EXHAUSTED'
  /** pons's own factory would refuse the launch: `launchEnabled` is off and we are not a
   *  whitelisted launcher, or the configured launch config is disabled. Nothing to do with
   *  us -- but sending anyway costs gas on a transaction that must revert. */
  | 'LAUNCHPAD_UNAVAILABLE'
  /** They asked to pair the launch against an asset pons has not approved, or one this
   *  factory cannot honour. Refused rather than substituted: the pairing decides what
   *  every buyer spends and what the creator is paid in, it is fixed forever at launch,
   *  and quietly launching against something else would be a permanent decision made on
   *  somebody's behalf. */
  | 'PAIR_ASSET_UNAVAILABLE'
  | 'DUPLICATE_TWEET';

export interface ValidationResult {
  approved: boolean;
  reason?: RejectionReason;
  detail?: string;
  sanitized?: {
    tokenName: string;
    tokenSymbol: string;
    description: string | null;
  };
}

export interface ResolvedWallet {
  xUserId: string;
  walletAddress: string;
  /** Opaque reference into whichever embedded-wallet provider (Privy/Turnkey) manages this
   * wallet's key material. The backend never sees or stores a raw private key. */
  providerRef: string;
}

export interface LaunchRecord {
  id: string;
  sourceTweetId: string;
  xUserId: string;
  tokenName: string;
  tokenSymbol: string;
  splitterAddress: string | null;
  tokenAddress: string | null;
  txHash: string | null;
  status: 'pending' | 'confirmed' | 'failed' | 'rejected';
  rejectionReason: RejectionReason | null;
  feeWeiPaid: string | null;
  createdAt: string;
}

export interface AccountSignals {
  xUserId: string;
  accountCreatedAt: string; // ISO
  followerCount: number;
}
