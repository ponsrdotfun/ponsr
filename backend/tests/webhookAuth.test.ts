import { webhookAuthorised, AuthorisableRequest } from '../src/webhookAuth';

const SECRET = 'a'.repeat(48);

function req(opts: { header?: string; query?: string } = {}): AuthorisableRequest {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-webhook-secret' ? opts.header : undefined),
    query: opts.query === undefined ? {} : { secret: opts.query },
  };
}

describe('webhookAuthorised', () => {
  it('accepts the secret in the x-webhook-secret header', () => {
    expect(webhookAuthorised(req({ header: SECRET }), SECRET)).toBe(true);
  });

  // Providers differ in whether they let you set custom headers on a webhook. A check that
  // cannot be satisfied gets switched off rather than fixed, so both forms are accepted.
  it('accepts the secret in a query parameter', () => {
    expect(webhookAuthorised(req({ query: SECRET }), SECRET)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(webhookAuthorised(req({ header: 'b'.repeat(48) }), SECRET)).toBe(false);
  });

  it('rejects a request presenting no secret at all', () => {
    expect(webhookAuthorised(req(), SECRET)).toBe(false);
  });

  // The decisive one. This endpoint spends money; an unconfigured secret must close the door,
  // not remove it. Mentions still arrive through the reconciliation sweep in that state, so
  // failing closed costs latency rather than the bot.
  it('rejects everything when no secret is configured', () => {
    expect(webhookAuthorised(req({ header: SECRET }), undefined)).toBe(false);
    expect(webhookAuthorised(req({ header: '' }), '')).toBe(false);
    expect(webhookAuthorised(req(), undefined)).toBe(false);
  });

  // A prefix must not pass. timingSafeEqual throws when the buffers differ in length, so the
  // length guard in front of it is doing real work, not tidying.
  it('rejects a prefix of the secret without throwing', () => {
    expect(() => webhookAuthorised(req({ header: SECRET.slice(0, 20) }), SECRET)).not.toThrow();
    expect(webhookAuthorised(req({ header: SECRET.slice(0, 20) }), SECRET)).toBe(false);
  });

  it('rejects a value longer than the secret', () => {
    expect(webhookAuthorised(req({ header: SECRET + 'x' }), SECRET)).toBe(false);
  });

  it('prefers the header when both are present, and still rejects a wrong one', () => {
    expect(webhookAuthorised({ header: () => 'wrong', query: { secret: SECRET } }, SECRET)).toBe(false);
  });
});
