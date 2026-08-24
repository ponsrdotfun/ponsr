import * as fs from 'fs';
import * as path from 'path';
import { config, parseConfig } from '../src/config';
import { assertTurnkeyPolicyAcknowledged } from '../src/treasurySigner';

/**
 * The parser was right and nothing used it.
 *
 * Round 5 replaced `z.coerce.boolean()` with `parseAcknowledgement`, wrote a test suite for
 * `parseAcknowledgement`, and reported the gate fixed. The schema still declared
 * `z.coerce.boolean()`. Every assertion passed, against a function no configuration path
 * called: `config.TURNKEY_POLICY_CONFIRMED` was still produced by the broken coercion, so a
 * production environment writing `TURNKEY_POLICY_CONFIRMED=false` still started its signer.
 *
 * These tests exercise the SCHEMA, through the same `ConfigSchema.parse` that builds the
 * exported config, so a green run is evidence about shipped behaviour rather than about a
 * helper. tests/ackGateParsing.test.ts keeps the unit-level cases; this file is the one that
 * would have failed.
 */

describe('the acknowledgement gate, as the executable config parses it', () => {
  /** Only the fields under test; every other field is optional or defaulted. */
  const parse = (raw?: string | boolean) =>
    parseConfig(raw === undefined ? {} : { TURNKEY_POLICY_CONFIRMED: raw as never })
      .TURNKEY_POLICY_CONFIRMED;

  it('defaults to refusing when the variable is absent', () => {
    expect(parse(undefined)).toBe(false);
  });

  it('accepts an exact affirmative', () => {
    expect(parse('true')).toBe(true);
    expect(parse(true)).toBe(true);
  });

  /**
   * The finding itself. Under `z.coerce.boolean()` every one of these parsed as TRUE, so the
   * gate answered "acknowledged" to an operator who had written the opposite.
   */
  it('reads a written refusal as a refusal', () => {
    expect(parse('false')).toBe(false);
    expect(parse('0')).toBe(false);
    expect(parse(false)).toBe(false);
  });

  it('tolerates case and whitespace without becoming permissive', () => {
    expect(parse(' TRUE ')).toBe(true);
    expect(parse('True')).toBe(true);
    expect(parse(' FALSE ')).toBe(false);
  });

  it('refuses every value that is not recognisably an affirmative', () => {
    for (const v of ['1', 'yes', 'on', '', 'y', 'confirmed']) {
      expect(parse(v)).toBe(false);
    }
  });
});

describe('production startup, driven by the actually-parsed value', () => {
  const original = config.TURNKEY_POLICY_CONFIRMED;
  const originalEnv = config.NODE_ENV;
  afterEach(() => {
    (config as { TURNKEY_POLICY_CONFIRMED: boolean }).TURNKEY_POLICY_CONFIRMED = original;
    (config as { NODE_ENV: string }).NODE_ENV = originalEnv;
  });

  /** The value is not a literal: it comes out of the schema, from the string an operator typed. */
  const asParsed = (raw: string) => {
    (config as { NODE_ENV: string }).NODE_ENV = 'production';
    (config as { TURNKEY_POLICY_CONFIRMED: boolean }).TURNKEY_POLICY_CONFIRMED =
      parseConfig({ TURNKEY_POLICY_CONFIRMED: raw as never }).TURNKEY_POLICY_CONFIRMED;
  };

  it('refuses to start when the operator wrote false', () => {
    asParsed('false');
    expect(() => assertTurnkeyPolicyAcknowledged()).toThrow(/TURNKEY_POLICY_CONFIRMED/);
  });

  it('refuses to start on any near-miss affirmative', () => {
    for (const v of ['0', '1', 'yes', 'on', '']) {
      asParsed(v);
      expect(() => assertTurnkeyPolicyAcknowledged()).toThrow(/TURNKEY_POLICY_CONFIRMED/);
    }
  });

  it('starts only on an exact affirmative', () => {
    asParsed('true');
    expect(() => assertTurnkeyPolicyAcknowledged()).not.toThrow();
    asParsed(' TRUE ');
    expect(() => assertTurnkeyPolicyAcknowledged()).not.toThrow();
  });
});

/**
 * The same coercion was inverting a second flag, found by sweeping for the pattern rather
 * than the symptom. `REPLY_INCLUDE_LINK=false` turned link-bearing replies ON, and X charges
 * $0.200 for a post containing a URL against $0.015 without. Not a safety gate, but the same
 * defect: the value an operator writes to decline is read as consent.
 */
describe('the reply-link cost opt-in reads what was written', () => {
  const parse = (raw?: string) =>
    parseConfig(raw === undefined ? {} : { REPLY_INCLUDE_LINK: raw }).REPLY_INCLUDE_LINK;

  it('stays off unless explicitly turned on', () => {
    expect(parse(undefined)).toBe(false);
    expect(parse('false')).toBe(false);
    expect(parse('0')).toBe(false);
    expect(parse('')).toBe(false);
  });

  it('turns on for an exact affirmative', () => {
    expect(parse('true')).toBe(true);
    expect(parse(' True ')).toBe(true);
  });
});

/**
 * A sentinel, not the proof — the behavioural tests above are that. It exists because the
 * exact regression it names has already happened once: the schema kept the broken coercion
 * while a correct parser sat unused beside it.
 */
describe('the schema does not quietly return to truthiness coercion', () => {
  it('does not declare TURNKEY_POLICY_CONFIRMED with z.coerce.boolean', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.ts'), 'utf8');
    const declaration = source
      .split('\n')
      .find((line) => line.includes('TURNKEY_POLICY_CONFIRMED:'));
    expect(declaration).toBeDefined();
    expect(declaration).not.toMatch(/z\.coerce\.boolean/);
    expect(declaration).toMatch(/parseAcknowledgement/);
  });

  /**
   * Broader than the finding, because the finding was found twice. `z.coerce.boolean()` is
   * never the right parser for an environment variable: the values live as strings, and every
   * non-empty string is truthy, so the coercion cannot express "no".
   */
  it('declares no field at all with z.coerce.boolean', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.ts'), 'utf8');
    const offenders = source
      .split('\n')
      .filter((line) => /^\s*[A-Z0-9_]+:\s*z\.coerce\.boolean/.test(line));
    expect(offenders).toEqual([]);
  });
});
