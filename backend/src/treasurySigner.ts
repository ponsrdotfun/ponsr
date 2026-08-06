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
 * DONE 2026-08-06: Turnkey is wired and the policy is verified by
 * `scripts/turnkey-verify-policy.ts` -- a transaction to the factory signs, an arbitrary
 * destination is refused. The bot signs as a non-root user; root bypasses every policy and
 * its key no longer lives in backend/.env.
 *
 * The policy is deliberately WIDER than the original plan above. It permits contract creation
 * as well as calls to the factory, because each launch deploys that launch's FeeSplitter and a
 * factory-only policy would refuse it. The value ceiling still applies. This was a considered
 * trade, not an oversight: the widening lets the key deploy code, and the denial of arbitrary
 * destinations is what still stops it moving funds.
 *
 * STILL OUTSTANDING:
 *   - Retire RawKeyTreasurySigner. It is still used by scripts/phase-b-launch.ts and
 *     scripts/collect-and-split.ts, which are operator tools run by hand, not the bot. It
 *     already refuses to run under NODE_ENV=production, so it cannot reach the bot's path --
 *     but it stays on this list until nothing constructs it from a raw key.
 */
export interface TreasurySigner {
  address(): Promise<string>;
  sendTransaction(tx: { to: string; data: string; value: bigint }): Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt | null> }>;
}

/**
 * Turnkey-backed treasury signer. Implemented 2026-08-04.
 *
 * ⚠️ THE SDK CANNOT ENFORCE THE POLICY. THE POLICY LIVES IN TURNKEY.
 *
 * This class holds an API key that can ask Turnkey to sign. What stops that key from
 * signing "transfer the treasury to an attacker" is a **policy configured in the Turnkey
 * dashboard or API**, not anything written here. Part 10 chose Turnkey precisely for that
 * pre-signing policy engine, and the choice is worth nothing until the policy exists:
 *
 *   - destination address == PONS_FACTORY_ADDRESS, and nothing else
 *   - function selector == launchToken's selector, and nothing else
 *   - per-transaction value ceiling == TREASURY_MAX_FEE_WEI
 *
 * Without those rules a Turnkey key is a bare key with extra steps -- worse than the raw
 * key below, because it *looks* protected. `assertTurnkeyPolicyAcknowledged()` exists to
 * make that impossible to forget silently; see its comment.
 *
 * Note the splitter deployment is a contract creation, not a call to the factory, so a
 * policy scoped only to `launchToken` will reject it. Either widen the policy deliberately
 * to cover it or deploy splitters from a separate, differently-scoped signer -- decide that
 * before mainnet rather than discovering it when the first launch half-completes.
 */
export class TurnkeyTreasurySigner implements TreasurySigner {
  private signer: any;

  constructor(
    organizationId: string,
    apiPublicKey: string,
    apiPrivateKey: string,
    /** Wallet account address, private key address, or private key ID. */
    signWith: string,
    provider: ethers.Provider,
    apiBaseUrl = 'https://api.turnkey.com'
  ) {
    if (!organizationId || !apiPublicKey || !apiPrivateKey || !signWith) {
      throw new Error(
        'Turnkey is not configured: set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY, ' +
          'TURNKEY_API_PRIVATE_KEY and TURNKEY_SIGN_WITH.'
      );
    }
    // Required here rather than imported at module scope, for the same reason as the Privy
    // client: keeping heavy provider SDKs out of the module graph is what lets the test
    // suite import this file at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Turnkey } = require('@turnkey/sdk-server');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TurnkeySigner } = require('@turnkey/ethers');
    const turnkey = new Turnkey({
      apiBaseUrl,
      apiPublicKey,
      apiPrivateKey,
      defaultOrganizationId: organizationId,
    });
    this.signer = new TurnkeySigner(
      { client: turnkey.apiClient(), organizationId, signWith },
      provider
    );
  }

  async address(): Promise<string> {
    return this.signer.getAddress();
  }

  async sendTransaction(tx: { to: string; data: string; value: bigint }) {
    return this.signer.sendTransaction(tx);
  }
}

/**
 * Refuses to start in production unless the operator has explicitly recorded that the
 * Turnkey policy exists.
 *
 * This is a checkbox, and a checkbox cannot verify a policy -- Turnkey's API would have to
 * be queried for that, and the shape of a "correct" policy is a judgement call. What it can
 * do is make the omission loud. The failure being guarded against is silent: a Turnkey
 * signer with no policy behaves identically to one with a perfect policy, right up until
 * the key is stolen and the thief discovers it can sign anything.
 */
export function assertTurnkeyPolicyAcknowledged(): void {
  if (config.NODE_ENV !== 'production') return;
  if (config.TURNKEY_POLICY_CONFIRMED !== true) {
    throw new Error(
      'TURNKEY_POLICY_CONFIRMED is not set. Before running in production, configure a Turnkey ' +
        'policy restricting this key to the pons factory address, the launchToken selector, and ' +
        'a value ceiling -- then set TURNKEY_POLICY_CONFIRMED=true to acknowledge it. An ' +
        'unpolicied Turnkey key can sign anything, and looks protected while doing it.'
    );
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
    assertTurnkeyPolicyAcknowledged();
    return new TurnkeyTreasurySigner(
      requireConfig('TURNKEY_ORGANIZATION_ID'),
      requireConfig('TURNKEY_API_PUBLIC_KEY'),
      requireConfig('TURNKEY_API_PRIVATE_KEY'),
      requireConfig('TURNKEY_SIGN_WITH'),
      provider
    );
  }
  // Outside production, prefer Turnkey when it is configured -- testing the real signer on
  // testnet is the only way to find out it works before it matters.
  if (config.TURNKEY_ORGANIZATION_ID && config.TURNKEY_SIGN_WITH) {
    return new TurnkeyTreasurySigner(
      config.TURNKEY_ORGANIZATION_ID,
      requireConfig('TURNKEY_API_PUBLIC_KEY'),
      requireConfig('TURNKEY_API_PRIVATE_KEY'),
      config.TURNKEY_SIGN_WITH,
      provider
    );
  }
  const key = requireConfig('TREASURY_SIGNER_PRIVATE_KEY');
  return new RawKeyTreasurySigner(key, provider);
}
