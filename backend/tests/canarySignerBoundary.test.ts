import * as fs from 'fs';
import * as path from 'path';
import { pinnedTreasuryAddress, assertSignerMatchesPin, assertRawKeyNotOnMainnet } from '../src/canarySignerBoundary';

/**
 * A dry run that needs a key is not a dry run.
 *
 * `phase-b-launch.ts` constructed `RawKeyTreasurySigner` or `createTreasurySigner` at line
 * 96 and awaited `signer.address()` at 98 — roughly two hundred lines before the EXECUTE
 * gate at 302. It requested no signature, so nothing was spent; but it loaded a
 * credential-bearing object to obtain a PUBLIC ADDRESS, which means the rehearsal cannot
 * run on a machine that holds no keys.
 *
 * The completion report then called it a "MAINNET KEYLESS DRY RUN". That was my claim and
 * it was wrong, which is worse than the defect: the whole point of a keyless rehearsal is
 * that someone can check it without being trusted with anything.
 *
 * The address is already available as non-secret configuration. Reading it from there costs
 * nothing and removes the credential from the path entirely.
 */

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

describe('the preflight address comes from configuration, not a signer', () => {
  it('resolves the pinned address from non-secret config', () => {
    expect(pinnedTreasuryAddress({ TURNKEY_SIGN_WITH: TREASURY })).toBe(TREASURY);
  });

  it('refuses rather than falling back to a signer when no address is configured', () => {
    expect(() => pinnedTreasuryAddress({})).toThrow(/address/i);
  });

  it('refuses a malformed address instead of carrying it into calldata', () => {
    expect(() => pinnedTreasuryAddress({ TURNKEY_SIGN_WITH: 'not-an-address' })).toThrow(/address/i);
  });
});

describe('the signer is checked against the pin before anything irreversible', () => {
  it('accepts a signer whose address matches, whatever the case', () => {
    expect(() => assertSignerMatchesPin(TREASURY.toLowerCase(), TREASURY)).not.toThrow();
  });

  /**
   * The failure this prevents is concrete. The script once defaulted to a raw-key wallet
   * while the whitelist named the Turnkey address; a launch would have come from a wallet
   * holding 0.000249 ETH, and the refusal would have read as "pons never granted it".
   */
  it('refuses a signer that is not the pinned treasury', () => {
    expect(() => assertSignerMatchesPin('0xdead000000000000000000000000000000000000', TREASURY)).toThrow(
      /does not match/i
    );
  });
});

describe('raw-key execution is impossible on mainnet', () => {
  it('refuses RAW_KEY on chain 4663', () => {
    expect(() => assertRawKeyNotOnMainnet(4663n, true)).toThrow(/mainnet/i);
  });

  it('allows RAW_KEY elsewhere, where it is a testing tool', () => {
    expect(() => assertRawKeyNotOnMainnet(46630n, true)).not.toThrow();
  });

  it('is silent when RAW_KEY is not set', () => {
    expect(() => assertRawKeyNotOnMainnet(4663n, false)).not.toThrow();
  });
});

describe('the script keeps the signer behind the execute gate', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('constructs no signer before the execute gate', () => {
    const gate = CODE.indexOf('if (!EXECUTE)');
    for (const ctor of ['createTreasurySigner(', 'new RawKeyTreasurySigner(']) {
      const at = CODE.indexOf(ctor);
      if (at === -1) continue;
      expect(at).toBeGreaterThan(gate);
    }
  });

  it('reads the preflight address from the pin instead', () => {
    const pin = CODE.indexOf('pinnedTreasuryAddress(');
    const gate = CODE.indexOf('if (!EXECUTE)');
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(gate);
  });

  it('verifies the signer against the pin before any journal prepare', () => {
    const check = CODE.indexOf('assertSignerMatchesPin(');
    const prepare = CODE.indexOf('journal.prepare(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(prepare);
  });

  /**
   * Re-anchored on signing. The script no longer has a combined send, and signing is now the
   * first irreversible-adjacent act: a raw key on mainnet must be refused before it is asked
   * to produce broadcastable bytes, not merely before those bytes go out.
   */
  it('refuses raw-key on mainnet before anything is signed', () => {
    const guard = CODE.indexOf('assertRawKeyNotOnMainnet(');
    const sign = CODE.indexOf('signAndPersist(');
    expect(guard).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sign);
  });
});
