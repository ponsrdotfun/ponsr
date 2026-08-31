/**
 * CLAIMING CREATOR FEES FROM THE ACCOUNT PAGES.
 *
 * Requested by the owner as a brief, which is what the backend freeze requires
 * before feature work: they want to sign in with X and press claim themselves.
 *
 * WHY THE TREASURY SENDS THIS, AND WHY THAT IS NOT WHAT IT SOUNDS LIKE
 * -------------------------------------------------------------------
 * `claimAndSplit` is permissionless and pays the CREATOR, never the caller. So
 * the treasury sending it cannot move anybody's fees anywhere except to the
 * person already owed them -- it is spending gas on their behalf and nothing
 * else. That is why this design keeps the custody boundary the account pages
 * advertise: the website never touches a private key, and no signature is asked
 * of the reader.
 *
 * WHAT THIS REFUSES TO DO
 * -----------------------
 *   - It never takes a launch id on trust. The launch must belong to the signed
 *     in numeric X id, read from the session rather than the request.
 *   - It re-reads the splitter's own `creator()` from chain and requires it to
 *     equal the session's wallet. The contract would pay the right person
 *     regardless, so this is not about theft -- it is about not spending the
 *     treasury's gas on a row that has drifted from the chain.
 *   - It refuses a zero balance rather than sending a transaction that reverts.
 *   - A signer refusal is reported AS a signer refusal. Until a Turnkey policy
 *     permits calls to splitter addresses, every claim will be denied, and that
 *     must not arrive as a generic failure that sends somebody looking for a
 *     bug in this file.
 */
import { ethers } from 'ethers';
import type { Db } from './db';
import type { TreasurySigner } from './treasurySigner';

/** `claimAndSplit(address)` and `creator()`, computed rather than remembered. */
const CLAIM_AND_SPLIT = ethers.id('claimAndSplit(address)').slice(0, 10);
const CREATOR = ethers.id('creator()').slice(0, 10);
const BALANCE_OF_TOKEN = ethers.id('balanceOfToken(address,address)').slice(0, 10);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type ClaimOutcome =
  | { state: 'sent'; hash: string; splitter: string; erc20: string }
  | { state: 'unauthenticated' }
  | { state: 'not-yours' }
  | { state: 'no-splitter' }
  | { state: 'nothing-to-claim' }
  | { state: 'wallet-mismatch' }
  | { state: 'signer-refused'; detail: string }
  | { state: 'unavailable'; detail: string };

export interface ClaimDeps {
  db: Db;
  provider: { call(tx: { to: string; data: string }): Promise<string> };
  signer: TreasurySigner;
}

const word = (address: string) => address.toLowerCase().replace('0x', '').padStart(64, '0');

/**
 * A refusal by the signer is a different fact from a chain being down.
 *
 * Turnkey answers a disallowed destination with a policy denial rather than a
 * network error, and the difference decides who is called: an operator to
 * change a policy, or nobody at all because the chain will be back.
 */
function isPolicyRefusal(error: unknown): boolean {
  const text = String((error as any)?.message ?? error).toLowerCase();
  return text.includes('policy') || text.includes('denied') || text.includes('not authorized') || text.includes('forbidden');
}

export class AccountClaimService {
  constructor(private deps: ClaimDeps) {}

  /** The splitter this launch pays through, or null. Read from provenance, which
   *  is where it is actually recorded -- `launches.splitter_address` is written
   *  null at insert and nothing has ever filled it in. */
  private splitterFor(launchId: string): string | null {
    const provenance: any = this.deps.db.getLaunchProvenance(launchId);
    const splitter = String(provenance?.splitter ?? '');
    return ADDRESS.test(splitter) ? ethers.getAddress(splitter) : null;
  }

  private async readAddress(to: string, data: string): Promise<string | null> {
    try {
      const raw = await this.deps.provider.call({ to, data });
      if (!raw || raw === '0x' || raw.length < 66) return null;
      return ethers.getAddress(`0x${raw.slice(-40)}`);
    } catch {
      return null;
    }
  }

  private async escrowBalance(escrow: string, splitter: string, erc20: string): Promise<bigint | null> {
    try {
      const raw = await this.deps.provider.call({
        to: escrow,
        data: `${BALANCE_OF_TOKEN}${word(splitter)}${word(erc20)}`,
      });
      if (!/^0x[0-9a-fA-F]+$/.test(String(raw))) return null;
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  /**
   * Claim one asset's fees for one launch belonging to the signed-in identity.
   *
   * `xUserId` and `wallet` come from the SESSION. Nothing about who the caller
   * is may be taken from the request body.
   */
  async claim(input: {
    xUserId?: string;
    wallet?: string;
    launchId?: string;
    erc20?: string;
  }): Promise<ClaimOutcome> {
    const { xUserId, wallet, launchId, erc20 } = input;
    if (!xUserId || !wallet) return { state: 'unauthenticated' };
    if (!launchId || !erc20 || !ADDRESS.test(erc20)) return { state: 'unavailable', detail: 'invalid_request' };

    // Ownership from the database, never from the request.
    const owns = this.deps.db.listLaunchesForUser(xUserId).some((l: any) => String(l.id) === launchId);
    if (!owns) return { state: 'not-yours' };

    const splitter = this.splitterFor(launchId);
    if (!splitter) return { state: 'no-splitter' };

    const provenance: any = this.deps.db.getLaunchProvenance(launchId);
    const escrow = String(provenance?.feeEscrow ?? '');
    if (!ADDRESS.test(escrow)) return { state: 'unavailable', detail: 'no_escrow_recorded' };

    // Defence in depth: the contract pays the creator whoever calls, so this is
    // not about theft. It is about not spending the treasury's gas on a row
    // that has drifted from the chain.
    const creator = await this.readAddress(splitter, CREATOR);
    if (!creator) return { state: 'unavailable', detail: 'creator_unreadable' };
    if (creator.toLowerCase() !== String(wallet).toLowerCase()) return { state: 'wallet-mismatch' };

    const balance = await this.escrowBalance(escrow, splitter, ethers.getAddress(erc20));
    if (balance === null) return { state: 'unavailable', detail: 'balance_unreadable' };
    // A zero balance reverts with NothingToClaim, which would burn gas to learn
    // what one free read already answered.
    if (balance === 0n) return { state: 'nothing-to-claim' };

    try {
      const sent = await this.deps.signer.sendTransaction({
        to: splitter,
        data: `${CLAIM_AND_SPLIT}${word(ethers.getAddress(erc20))}`,
        value: 0n,
      });
      return { state: 'sent', hash: sent.hash, splitter, erc20: ethers.getAddress(erc20) };
    } catch (error) {
      if (isPolicyRefusal(error)) {
        return {
          state: 'signer-refused',
          detail: 'The signer policy does not permit calls to splitter addresses.',
        };
      }
      return { state: 'unavailable', detail: 'send_failed' };
    }
  }
}
