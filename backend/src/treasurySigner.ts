import { ethers } from 'ethers';
import { config, requireConfig } from './config';

/**
 * The treasury signer pays every launch fee on the bot's behalf (Part 8's fee model
 * decision). Per Part 5's audit and Part 10's research, this MUST be a policy-scoped signer
 * in production, never a bare private key sitting in an env var -- Turnkey has documented
 * "Tier 4" native support for Robinhood Chain specifically (transaction parsing + policy
 * creation before signing), which is the purpose-built way to enforce "this key may only
 * ever call launchToken() on the Pons factory address, nothing else."
 *
 * TODO before Phase 3 / any mainnet exposure (see action-checklist.md):
 *   1. Sign up for Turnkey, create an organization + a wallet scoped via policy to:
 *        - destination address == PONS_FACTORY_ADDRESS only
 *        - function selector == launchToken's selector only
 *        - a per-transaction value ceiling matching TREASURY_MAX_FEE_WEI
 *   2. Replace TurnkeyTreasurySigner's stub body with real Turnkey SDK calls.
 *   3. Retire RawKeyTreasurySigner entirely once Turnkey is wired up -- it exists ONLY for
 *      local testnet development, per the explicit warning below.
 */
export interface TreasurySigner {
  address(): Promise<string>;
  sendTransaction(tx: { to: string; data: string; value: bigint }): Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt | null> }>;
}

/** Stub for the real Turnkey-backed signer. Left unimplemented deliberately -- see the TODO
 * above. Do not fill this in with a workaround that bypasses Turnkey's policy engine; the
 * whole point of choosing Turnkey here (Part 10) is the pre-signing policy enforcement. */
export class TurnkeyTreasurySigner implements TreasurySigner {
  constructor(private turnkeyOrgId: string, private turnkeyApiKey: string) {}

  async address(): Promise<string> {
    throw new Error('TurnkeyTreasurySigner is a stub -- wire up real Turnkey SDK calls before Phase 3.');
  }

  async sendTransaction(): Promise<any> {
    throw new Error('TurnkeyTreasurySigner is a stub -- wire up real Turnkey SDK calls before Phase 3.');
  }
}

/**
 * ⚠️ TESTNET / LOCAL DEVELOPMENT ONLY ⚠️
 * A raw private-key signer with none of Turnkey's policy scoping. This class exists solely
 * so Phase 1 (Part 11) can prove the end-to-end loop works on testnet with test ETH, where a
 * compromised key has zero real-world consequence. Per Part 5's audit, this must NEVER be
 * used once the treasury holds real funds -- there is no scoping here; this key could sign
 * any transaction, which is exactly the single-point-of-failure risk the audit calls out.
 */
export class RawKeyTreasurySigner implements TreasurySigner {
  private wallet: ethers.Wallet;

  constructor(privateKey: string, provider: ethers.Provider) {
    if (config.NODE_ENV === 'production') {
      throw new Error(
        'RawKeyTreasurySigner must never be used in production -- see Part 5 audit. Use TurnkeyTreasurySigner instead.'
      );
    }
    this.wallet = new ethers.Wallet(privateKey, provider);
  }

  async address(): Promise<string> {
    return this.wallet.address;
  }

  async sendTransaction(tx: { to: string; data: string; value: bigint }) {
    return this.wallet.sendTransaction(tx);
  }
}

export function createTreasurySigner(provider: ethers.Provider): TreasurySigner {
  if (config.NODE_ENV === 'production') {
    // Real integration point -- see class-level TODO.
    throw new Error(
      'Production treasury signer not yet wired up. Complete the Turnkey integration TODO in treasurySigner.ts before deploying to production.'
    );
  }
  const key = requireConfig('TREASURY_SIGNER_PRIVATE_KEY');
  return new RawKeyTreasurySigner(key, provider);
}
