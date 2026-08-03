import { parseAndValidateModelOutput, MockParser } from '../src/parser';

describe('parseAndValidateModelOutput', () => {
  it('parses a well-formed response correctly', () => {
    const raw = JSON.stringify({
      isLaunchIntent: true,
      confidence: 'high',
      tokenName: 'Moon Coin',
      tokenSymbol: 'MOON',
      description: null,
    });
    const result = parseAndValidateModelOutput(raw);
    expect(result).toEqual({
      isLaunchIntent: true,
      confidence: 'high',
      tokenName: 'Moon Coin',
      tokenSymbol: 'MOON',
      description: null,
    });
  });

  it('strips markdown code fences if the model wraps its output despite instructions', () => {
    const raw = '```json\n' + JSON.stringify({
      isLaunchIntent: true, confidence: 'high', tokenName: 'X', tokenSymbol: 'X', description: null,
    }) + '\n```';
    const result = parseAndValidateModelOutput(raw);
    expect(result.tokenName).toBe('X');
  });

  it('fails safe (isLaunchIntent: false) on malformed JSON rather than throwing or guessing', () => {
    const result = parseAndValidateModelOutput('not json at all {{{');
    expect(result.isLaunchIntent).toBe(false);
    expect(result.tokenName).toBeNull();
  });

  it('fails safe when a required enum field is invalid', () => {
    const raw = JSON.stringify({
      isLaunchIntent: true, confidence: 'super-duper-high', tokenName: 'X', tokenSymbol: 'X', description: null,
    });
    const result = parseAndValidateModelOutput(raw);
    expect(result.isLaunchIntent).toBe(false);
  });

  it('CRITICAL SECURITY PROPERTY: strips any field outside the fixed schema -- e.g. a prompt-injection attempt to add a wallet override', () => {
    // This simulates what would happen if a compromised/tricked model tried to emit an
    // extra field in response to injected instructions in tweet text (eval set cases
    // 022-026). Zod's default behavior strips unknown keys from a parsed object, so even in
    // the worst case where the model attempts this, it structurally cannot reach the rest
    // of the pipeline.
    const raw = JSON.stringify({
      isLaunchIntent: true,
      confidence: 'high',
      tokenName: 'Test Coin',
      tokenSymbol: 'TEST',
      description: null,
      feeWalletOverride: '0x1234567890abcdef1234567890abcdef12345678', // attempted injection
      adminMode: true, // attempted injection
    });
    const result = parseAndValidateModelOutput(raw);
    expect(result).toEqual({
      isLaunchIntent: true,
      confidence: 'high',
      tokenName: 'Test Coin',
      tokenSymbol: 'TEST',
      description: null,
    });
    expect((result as any).feeWalletOverride).toBeUndefined();
    expect((result as any).adminMode).toBeUndefined();
  });

  it('rejects overly long tokenName/tokenSymbol values (defense in depth alongside validator.ts)', () => {
    const raw = JSON.stringify({
      isLaunchIntent: true,
      confidence: 'high',
      tokenName: 'A'.repeat(200),
      tokenSymbol: 'X',
      description: null,
    });
    const result = parseAndValidateModelOutput(raw);
    expect(result.isLaunchIntent).toBe(false);
  });
});

describe('MockParser', () => {
  it('returns the registered fixed response for an exact input match', async () => {
    const responses = new Map([
      ['gue mau launch token namanya Moon Coin simbolnya MOON dong bro', {
        isLaunchIntent: true as const,
        confidence: 'high' as const,
        tokenName: 'Moon Coin',
        tokenSymbol: 'MOON',
        description: null,
      }],
    ]);
    const parser = new MockParser(responses);
    const result = await parser.parse('gue mau launch token namanya Moon Coin simbolnya MOON dong bro');
    expect(result.tokenName).toBe('Moon Coin');
  });

  it('throws a clear error for an unregistered input, rather than silently returning something wrong', async () => {
    const parser = new MockParser(new Map());
    await expect(parser.parse('unregistered tweet text')).rejects.toThrow();
  });
});
