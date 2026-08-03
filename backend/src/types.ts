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
