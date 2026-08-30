import { ResolvedWallet } from './types';
import { Db } from './db';
import { ethers } from 'ethers';

/**
 * Resolves an X user ID to a wallet address, generating a new non-custodial wallet on first
 * contact. Per Part 10 of the master doc: Privy is a reasonable choice here (Turnkey is
 * specifically recommended for the TREASURY signer instead, due to its native Robinhood
 * Chain policy support -- see treasurySigner.ts).
 *
 * Implemented 2026-08-04 against @privy-io/node (the SDK npm now points to;
 * @privy-io/server-auth, which the original TODO named, is deprecated).
 */
export interface WalletResolver {
  resolve(xUserId: string, xHandle: string): Promise<ResolvedWallet>;
}

/**
 * Privy-backed resolver: one embedded wallet per X user, created on first contact.
 *
 * Two properties of this integration are load-bearing, not incidental:
 *
 *  1. **The backend never sees a private key.** Privy holds the key material; we hold an
 *     address and a wallet id. That is the whole reason a provider is used here rather than
 *     generating EOAs ourselves -- a compromise of this service must not be a compromise of
 *     every user's wallet.
 *
 *  2. **`external_id` is the X user ID.** Privy enforces it as write-once and unique, which
 *     makes it a second, independent guarantee that one X account maps to exactly one wallet.
 *     The local `users` table is the fast path; this is what stops a database restore, a race,
 *     or a bug from ever minting a second wallet for someone who already has one. On that
 *     collision Privy rejects the create, and we look the existing wallet up instead of
 *     surfacing an error -- the user already has a wallet, which is the desired end state.
 */
export class PrivyWalletResolver implements WalletResolver {
  private client: any = null;

  constructor(private db: Db, private privyAppId: string, private privyAppSecret: string, client?: any) { this.client=client??null; }

  /**
   * Loaded on first use, not at import time.
   *
   * The SDK depends on `jose`, which ships ESM-only, and pulling it into the module graph
   * broke every test that imports the orchestrator -- Jest runs CommonJS and cannot parse
   * it. Requiring it here means the mock resolver's callers never load it at all, which is
   * also simply correct: a process running on mocks has no reason to pay for this SDK.
   */
  private privy(): any {
    if (!this.client) {
      if (!this.privyAppId || !this.privyAppSecret) {
        throw new Error('Privy is not configured: set PRIVY_APP_ID and PRIVY_APP_SECRET.');
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PrivyClient } = require('@privy-io/node');
      this.client = new PrivyClient({ appId: this.privyAppId, appSecret: this.privyAppSecret });
    }
    return this.client;
  }

  /** Account login verifies DB ↔ Privy continuity with a lookup-only provider call.
   * Mismatch or provider failure is unavailable; this path never calls create(). */
  async lookupExistingVerified(xUserId: string): Promise<ResolvedWallet | null> {
    const stored=this.db.getUser(xUserId);if(!stored)return null;
    const provider=await this.findByExternalId(xUserId);if(!provider)return null;
    if(provider.id!==stored.providerRef||ethers.getAddress(provider.address)!==ethers.getAddress(stored.walletAddress))return null;
    return stored;
  }

  async resolve(xUserId: string, xHandle: string): Promise<ResolvedWallet> {
    const existing = this.db.getUser(xUserId);
    if (existing) return existing;

    const privy = this.privy();
    let created: { id: string; address: string };

    try {
      created = (await privy.wallets().create({
        chain_type: 'ethereum',
        // Write-once and unique on Privy's side. See the class comment: this is the
        // idempotency guarantee that does not depend on our database being intact.
        external_id: externalIdFor(xUserId),
        display_name: `ponsr:@${xHandle}`,
      })) as { id: string; address: string };
    } catch (err: any) {
      // A duplicate external_id means this user already has a wallet and our table has lost
      // the row. Recover it rather than failing the launch -- and never create a second one.
      const recovered = await this.findByExternalId(xUserId);
      if (!recovered) throw err;
      created = recovered;
    }

    const wallet: ResolvedWallet = {
      xUserId,
      walletAddress: ethers.getAddress(created.address),
      providerRef: created.id,
    };
    this.db.upsertUser(xUserId, xHandle, wallet);
    return wallet;
  }

  private async findByExternalId(xUserId: string): Promise<{ id: string; address: string } | null> {
    try {
      const page: any = await (this.privy().wallets() as any).list({
        external_id: externalIdFor(xUserId),
        limit: 1,
      });
      const first = (page?.data ?? page?.wallets ?? [])[0];
      return first ? { id: first.id, address: first.address } : null;
    } catch {
      return null;
    }
  }
}

/** URL-safe, max 64 chars, per Privy's constraint on external_id. X user IDs are numeric,
 *  but the prefix keeps these distinguishable if this Privy app is ever shared. */
export function externalIdFor(xUserId: string): string {
  return `ponsr-x-${String(xUserId).replace(/[^a-zA-Z0-9_-]/g, '')}`.slice(0, 64);
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
