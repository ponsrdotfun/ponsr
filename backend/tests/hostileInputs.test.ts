import { csvField, csvRow, safeChecks, safeDependencies } from '../src/sampleGuards';
import {
  parseAddress,
  parseArgInteger,
  parseArgWei,
  parseBoolean,
  parseCount,
  parseFingerprint,
  parseOrigin,
  parsePositive,
  parseTimestamp,
  parseWei,
} from '../src/strictParse';

/**
 * Everything that arrives from outside: public JSON and command-line arguments.
 *
 * The validator used to call `BigInt()` on raw JSON, so a field of `"not-a-bigint"` made it
 * THROW rather than fail -- and a thrown validator has no closed failure vocabulary at the
 * one moment it needs one. The sampler dereferenced unvalidated rows, so one odd response
 * could abort a whole measurement run. Both are the same mistake: trusting shape.
 */

describe('strict wei parsing refuses everything that is not exactly a decimal quantity', () => {
  it.each([
    ['a plain integer', '12', 12n],
    ['zero', '0', 0n],
    ['a large but sane value', '10000000000000000', 10000000000000000n],
  ])('accepts %s', (_l, raw, expected) => {
    expect(parseWei(raw)).toBe(expected);
  });

  it.each([
    ['empty', ''],                    // BigInt('') is 0n -- an absent field reading as a real zero
    ['whitespace padded', ' 12 '],    // BigInt(' 12 ') succeeds; two different bytes comparing equal
    ['a leading plus', '+12'],
    ['negative', '-1'],               // a signed quantity that cannot be negative
    ['a decimal point', '1.0'],
    ['exponent notation', '1e3'],
    ['hex', '0x0a'],                  // the same value with two spellings
    ['leading zeros', '007'],
    ['not a string', 12],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['absurdly large', '9'.repeat(60)],
  ])('refuses %s', (_l, raw) => {
    expect(parseWei(raw as unknown)).toBeNull();
  });

  it('never throws, for any input at all', () => {
    for (const raw of ['', 'x', '-', '0x', {}, [], null, undefined, NaN, Symbol('s')]) {
      expect(() => parseWei(raw as unknown)).not.toThrow();
    }
  });
});

describe('strict numeric and shape parsing', () => {
  it('parseCount refuses NaN, Infinity, floats, negatives and non-numbers', () => {
    expect(parseCount(5)).toBe(5);
    expect(parseCount(0)).toBe(0);
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, '3', null, undefined, {}]) {
      expect(parseCount(bad as unknown)).toBeNull();
    }
  });

  it('parsePositive additionally refuses zero, because zero is not a block', () => {
    expect(parsePositive(1)).toBe(1);
    expect(parsePositive(0)).toBeNull();
    expect(parsePositive(-1)).toBeNull();
  });

  it('parseBoolean refuses truthy values that are not booleans', () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
    for (const bad of [1, 0, 'true', 'false', null, undefined, {}, []]) {
      expect(parseBoolean(bad as unknown)).toBeNull();
    }
  });

  it('parseAddress checks shape and normalises case', () => {
    expect(parseAddress('0x' + 'Ab'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
    for (const bad of ['0x123', 'not-an-address', '0x' + 'zz'.repeat(20), 42, null]) {
      expect(parseAddress(bad as unknown)).toBeNull();
    }
  });

  it('parseFingerprint accepts only 12 lowercase hex characters', () => {
    expect(parseFingerprint('78ccdeee5ef1')).toBe('78ccdeee5ef1');
    for (const bad of ['78CCDEEE5EF1', 'not-hex', '78ccdeee5ef', '78ccdeee5ef12', 12, null]) {
      expect(parseFingerprint(bad as unknown)).toBeNull();
    }
  });

  it('parseOrigin refuses anything carrying a path, query or userinfo', () => {
    expect(parseOrigin('https://rpc.example.com')).toBe('https://rpc.example.com');
    expect(parseOrigin('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
    // If one of these ever appears in a published origin it is a leak, and accepting it
    // would be helping to hide one.
    for (const bad of [
      'https://rpc.example.com/v2/KEY',
      'https://rpc.example.com/?k=1',
      'https://user:pass@rpc.example.com',
      'not a url',
      42,
    ]) {
      expect(parseOrigin(bad as unknown)).toBeNull();
    }
  });

  it('parseTimestamp refuses nonsense without throwing', () => {
    expect(parseTimestamp('2026-08-26T00:00:00.000Z')).toBeGreaterThan(0);
    for (const bad of ['not-a-date', '', 42, null, {}]) {
      expect(parseTimestamp(bad as unknown)).toBeNull();
    }
  });
});

describe('CLI arguments are parsed strictly and never echoed', () => {
  it('accepts sane integers within bounds', () => {
    expect(parseArgInteger('10', 1, 100)).toBe(10);
    expect(parseArgInteger('0')).toBe(0);
  });

  it.each([
    ['NaN', 'NaN'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['empty', ''],
    ['hex', '0x10'],
    ['whitespace', ' 5 '],
    ['absurdly long', '9'.repeat(30)],
    ['undefined', undefined],
  ])('refuses %s', (_l, raw) => {
    expect(parseArgInteger(raw as string | undefined)).toBeNull();
  });

  it('enforces the caller bounds', () => {
    expect(parseArgInteger('0', 1)).toBeNull();
    expect(parseArgInteger('1000', 0, 999)).toBeNull();
  });

  it('parseArgWei is the same strictness as the JSON parser', () => {
    expect(parseArgWei('500000000000000')).toBe(500000000000000n);
    expect(parseArgWei('-1')).toBeNull();
    expect(parseArgWei('1e3')).toBeNull();
  });
});

describe('the sampler survives hostile public JSON', () => {
  it('returns an empty list rather than throwing on a non-array', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      expect(safeChecks(bad as unknown)).toEqual([]);
      expect(safeDependencies(bad as unknown)).toEqual([]);
    }
  });

  it('skips malformed rows instead of aborting the run', () => {
    const checks = safeChecks([
      null,
      42,
      { name: 'rpc', state: 'ok' },
      { name: 'no-state' },
      { state: 'ok' },
      { name: 'BAD NAME', state: 'ok' },
      { name: 'launchpad', state: 'degraded' },
    ]);
    // One odd row must not cost the whole sample; the good rows still come through.
    expect(checks).toEqual([
      { name: 'rpc', state: 'ok' },
      { name: 'launchpad', state: 'degraded' },
    ]);
  });

  it('skips dependency rows with impossible timings', () => {
    const deps = safeDependencies([
      { name: 'chain', ms: 10, outcome: 'ok' },
      { name: 'chain', ms: -1, outcome: 'ok' },
      { name: 'chain', ms: NaN, outcome: 'ok' },
      { name: 'chain', ms: 'x', outcome: 'ok' },
      { name: 'read-credits', ms: 4000, outcome: 'timed-out' },
    ]);
    expect(deps).toEqual([
      { name: 'chain', ms: 10, outcome: 'ok' },
      { name: 'read-credits', ms: 4000, outcome: 'timed-out' },
    ]);
  });
});

describe('CSV output cannot break columns or become a formula', () => {
  it.each([
    ['equals', '=cmd()'],
    ['plus', '+1+1'],
    ['minus', '-1+1'],
    ['at', '@SUM(A1)'],
    ['tab', '\tx'],
  ])('neutralises a %s-leading cell', (_l, value) => {
    const out = csvField(value);
    // The leading apostrophe is what stops a spreadsheet executing the cell. Quoting alone
    // does not: the quotes are consumed by the CSV reader before the formula is seen.
    expect(out.startsWith("'")).toBe(true);
  });

  it('quotes and escapes anything that would shift a column', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('leaves ordinary values alone', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField(42)).toBe('42');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('builds a row whose column count survives hostile content', () => {
    const row = csvRow(['a,b', '=x', 'plain']);
    // Three fields in, three fields out -- the comma inside the first is quoted, not a
    // separator.
    expect(row.split(',').length).toBeGreaterThanOrEqual(3);
    expect(row).toContain('"a,b"');
    expect(row).toContain("'=x");
  });
});
