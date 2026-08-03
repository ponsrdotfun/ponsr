import { ResolvedWallet } from './types';
import { Db } from './db';
import { ethers } from 'ethers';

/**
 * Resolves an X user ID to a wallet address, generating a new non-custodial wallet on first
 * contact. Per Part 10 of the master doc: Privy is a reasonable choice here (Turnkey is
 * specifically recommended for the TREASURY signer instead, due to its native Robinhood
 * Chain policy support -- see treasurySigner.ts).
 *
 * TODO before Phase 2 (see action-checklist.md + Part 11 roadmap):
 *   1. Sign up for Privy, get an API key.
 *   2. Replace PrivyWalletResolver's stub body with real Privy SDK calls:
 *      - `privy.walletApi.create({ chainType: 'ethereum' })` (or the SDK's current
 *        equivalent) to generate a new embedded wallet
 *      - Configure a POLICY on that wallet scoped to signing only, never a blanket signer --
 *        this wallet holds the USER's own funds/fee claims, so it doesn't need the same
 *        tight contract-call scoping as the treasury signer, but should still not be a
 *        completely unrestricted key from Privy's dashboard.
 *   3. Persist the mapping via `db.upsertUser(...)` exactly as the interface already does.
 */
export interface WalletResolver {
  resolve(xUserId: string, xHandle: string): Promise<ResolvedWallet>;
}

/** Real implementation shell for Privy. Left as a clearly-marked stub -- filling this in
 * requires an actual Privy account (see Phase 0 of the implementation roadmap). Wired to the
 * real Privy Node SDK's shape as of writing, so this should need minimal changes once a real
 * API key is available; not lines you can naively delete since the signature and DB write
 * pattern is production-shaped, just the two inner calls need swapping for the real SDK. */
export class PrivyWalletResolver implements WalletResolver {
  constructor(private db: Db, private privyAppId: string, private privyAppSecret: string) {}

  async resolve(xUserId: string, xHandle: string): Promise<ResolvedWallet> {
    const existing = this.db.getUser(xUserId);
    if (existing) return existing;

    // TODO (Phase 2): replace with a real Privy SDK call, e.g.:
    //   const privy = new PrivyClient(this.privyAppId, this.privyAppSecret);
    //   const wallet = await privy.walletApi.createWallet({ chainType: 'ethereum' });
    //   const walletAddress = wallet.address;
    //   const providerRef = wallet.id;
    throw new Error(
      'PrivyWalletResolver is a stub -- wire up real Privy SDK calls before Phase 2. See TODO comments above this line.'
    );
  }
}

/** Deterministic, fully-functional mock for local dev/testnet/tests. Generates a real,
 * usable EOA wallet per X user ID (deterministically derived so repeated runs in tests are
 * reproducible), persisted the same way the real resolver will persist Privy-issued wallets.
 * This is NOT non-custodial in the way Phase 2's real Privy integration will be (the private
 * key is derivable here, which is fine for testnet-only mock use and never appropriate once
 * real funds are involved) -- see the warning in generateMockWallet(). */
export class MockWalletResolver implements WalletResolver {
  constructor(private db: Db) {}

  async resolve(xUserId: string, xHandle: string): Promise<ResolvedWallet> {
    const existing = this.db.getUser(xUserId);
    if (existing) return existing;

    const { address, providerRef } = generateMockWallet(xUserId);
    const wallet: ResolvedWallet = { xUserId, walletAddress: address, providerRef };
    this.db.upsertUser(xUserId, xHandle, wallet);
    return wallet;
  }
}

/** WARNING: deterministic and NOT secure. Testnet/mock use only -- the whole point of the
 * real Phase 2 integration is that the backend never holds or can derive a user's private
 * key. Do not use this function's output with any wallet that will ever hold real funds. */
export function generateMockWallet(seed: string): { address: string; providerRef: string } {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`mock-wallet-seed:${seed}`));
  const wallet = new ethers.Wallet(hash);
  return { address: wallet.address, providerRef: `mock:${hash.slice(0, 10)}` };
}
