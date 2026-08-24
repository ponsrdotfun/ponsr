import { ethers } from 'ethers';

/**
 * Keeping credentials out of a rehearsal that does not need them.
 *
 * `phase-b-launch.ts` constructed a signer at line 96 and awaited `signer.address()` at 98
 * — about two hundred lines before the EXECUTE gate. It requested no signature and spent
 * nothing, but it loaded a credential-bearing object to obtain a PUBLIC ADDRESS. A
 * rehearsal that requires a key cannot be run by anybody who does not hold one, which
 * removes most of the value of having a rehearsal.
 *
 * The completion report then described it as a "MAINNET KEYLESS DRY RUN". That claim was
 * mine and it was false. The defect was small; the claim was the part that could have led
 * someone to run the dry run on a machine they thought was safe.
 *
 * The address is already non-secret configuration. Reading it from there is free.
 */

/**
 * The treasury address, from configuration rather than from a key.
 *
 * Throws rather than falling back to a signer. A fallback would make the keyless property
 * conditional on configuration nobody checks, and it would hold on the machine where it was
 * written and quietly stop holding everywhere else.
 */
export function pinnedTreasuryAddress(env: { TURNKEY_SIGN_WITH?: string; TREASURY_ADDRESS?: string }): string {
  const raw = env.TREASURY_ADDRESS ?? env.TURNKEY_SIGN_WITH;
  if (!raw) {
    throw new Error(
      'no treasury address is configured. Set TURNKEY_SIGN_WITH (or TREASURY_ADDRESS) so the ' +
        'preflight can read the address without loading a signing credential.'
    );
  }
  if (!ethers.isAddress(raw)) {
    throw new Error(`configured treasury address ${raw} is not a valid address`);
  }
  return ethers.getAddress(raw);
}

/**
 * Proves the signer that is about to spend is the account the preflight measured.
 *
 * Everything checked before this point -- balance, readiness, the cap, the pair -- was
 * measured against the pinned address. A signer resolving to anything else means the
 * preflight described a different account from the one about to pay, and every green line
 * above it was about somebody else.
 *
 * This has happened here in the other direction: the script once defaulted to a raw-key
 * wallet while the whitelist named the Turnkey address. The launch would have come from a
 * wallet holding 0.000249 ETH, and the refusal would have read as "pons never granted it".
 */
export function assertSignerMatchesPin(signerAddress: string, pinned: string): void {
  if (signerAddress.toLowerCase() !== pinned.toLowerCase()) {
    throw new Error(
      `the signer resolved to ${signerAddress}, which does not match the pinned treasury ` +
        `${pinned}. Every preflight reading above was taken against the pinned address, so ` +
        'none of it describes the account that would pay.'
    );
  }
}

/** Robinhood Chain mainnet. */
const MAINNET_CHAIN_ID = 4663n;

/**
 * Raw-key signing is a testnet tool and must stay one.
 *
 * RAW_KEY=1 exists so the retired raw wallet can be the deliberate subject of a run. On
 * mainnet it means a permanent token launched from an address the Turnkey policy does not
 * govern -- outside the value ceiling, outside the destination constraints, outside every
 * control the last two weeks were spent building.
 */
export function assertRawKeyNotOnMainnet(chainId: bigint, rawKeyRequested: boolean): void {
  if (rawKeyRequested && chainId === MAINNET_CHAIN_ID) {
    throw new Error(
      'RAW_KEY=1 is refused on mainnet (chain 4663). A raw key signs outside the Turnkey ' +
        'policy, so none of the value, destination or creation constraints apply to it.'
    );
  }
}
