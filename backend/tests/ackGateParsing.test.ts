import { parseAcknowledgement } from '../src/config';

/**
 * A gate that accepts the word "false" as yes.
 *
 * `TURNKEY_POLICY_CONFIRMED` used `z.coerce.boolean()`. Zod's coercion is JavaScript
 * truthiness, and every non-empty string is truthy — so with the version pinned here:
 *
 *     "false" -> true
 *     "0"     -> true
 *
 * `treasurySigner.ts` refuses to start in production unless this is true. An operator who
 * deliberately wrote `TURNKEY_POLICY_CONFIRMED=false` — the exact action someone takes when
 * they are NOT sure the signer policy is right — had production start anyway, with the
 * signer instantiated at boot.
 *
 * The failure direction is what makes it material rather than cosmetic. A parser that turns
 * a refusal into a confirmation gives its most confident answer precisely when somebody was
 * trying to say no.
 *
 * These are unit cases and they are NOT the proof. This whole suite passed for a full review
 * round while `ConfigSchema` still declared `z.coerce.boolean()`, so every assertion here was
 * green about a function no configuration path called. The evidence that the shipped gate
 * behaves this way lives in tests/ackGateSchema.test.ts, which parses the schema itself.
 */

describe('the acknowledgement gate reads what was written', () => {
  it('accepts only an exact affirmative', () => {
    expect(parseAcknowledgement('true')).toBe(true);
    expect(parseAcknowledgement(true)).toBe(true);
  });

  /** The whole finding, in four lines. */
  it('reads a written refusal as a refusal', () => {
    expect(parseAcknowledgement('false')).toBe(false);
    expect(parseAcknowledgement('0')).toBe(false);
    expect(parseAcknowledgement(false)).toBe(false);
  });

  it('defaults to refusing when nothing was written', () => {
    expect(parseAcknowledgement(undefined)).toBe(false);
    expect(parseAcknowledgement('')).toBe(false);
  });

  /**
   * Tolerant about shape, strict about meaning. An operator typing TRUE or " true " means
   * yes; anything that is not recognisably an affirmative means no.
   */
  it('tolerates case and whitespace without becoming permissive', () => {
    expect(parseAcknowledgement('TRUE')).toBe(true);
    expect(parseAcknowledgement('  true  ')).toBe(true);
    expect(parseAcknowledgement('True')).toBe(true);
    expect(parseAcknowledgement(' FALSE ')).toBe(false);
  });

  /** Anything unrecognised is a refusal, never an accident. */
  it('refuses values it does not understand', () => {
    for (const v of ['yes', 'y', 'confirmed', '1', 'on', 'null', 'undefined']) {
      expect(parseAcknowledgement(v)).toBe(false);
    }
  });
});
