import { TelegramNotifier, MockNotifier } from '../src/monitor';
import { Alert } from '../src/monitor';

const alert: Alert = {
  kind: 'TREASURY_LOW',
  severity: 'critical',
  message: 'Hot wallet cannot fund a launch.',
  detail: { balanceWei: '0', state: 'EMPTY' },
  at: '2026-08-11T06:00:00.000Z',
};

function mockFetch(impl: (url: string, init: any) => Promise<any>) {
  (global as any).fetch = jest.fn(impl);
  return (global as any).fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TelegramNotifier', () => {
  it('posts the alert to the Telegram sendMessage endpoint', async () => {
    const f = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await new TelegramNotifier('TOKEN', '123').send(alert);

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('123');
    expect(body.text).toContain('CRITICAL');
    expect(body.text).toContain('TREASURY_LOW');
    expect(body.text).toContain('Hot wallet cannot fund a launch.');
  });

  // Telegram rejects Markdown/HTML messages containing unescaped special characters, and these
  // alerts carry user-supplied token symbols. Sending as plain text is what stops a symbol like
  // _MOON_ from turning an alert into an API error.
  it('sends plain text, never a parse_mode', async () => {
    const f = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await new TelegramNotifier('TOKEN', '123').send(alert);
    expect(JSON.parse(f.mock.calls[0][1].body).parse_mode).toBeUndefined();
  });

  // The decisive property. recordRejection runs inside the launch path, so a notifier that
  // throws would turn a brief Telegram outage into a failed launch for a user who did nothing
  // wrong. An alert transport must never break the thing it is watching.
  it('does not throw when the network fails, and falls back instead', async () => {
    mockFetch(async () => {
      throw new Error('ENOTFOUND api.telegram.org');
    });
    const fallback = new MockNotifier();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new TelegramNotifier('TOKEN', '123', fallback).send(alert)).resolves.toBeUndefined();
    expect(fallback.sent).toHaveLength(1);
    expect(fallback.sent[0].kind).toBe('TREASURY_LOW');
  });

  it('does not throw on a non-2xx response', async () => {
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }));
    const fallback = new MockNotifier();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new TelegramNotifier('TOKEN', '123', fallback).send(alert)).resolves.toBeUndefined();
    expect(fallback.sent).toHaveLength(1);
  });

  // Telegram answers HTTP 200 with ok:false for real delivery failures -- a bot blocked by the
  // user is the common one. Checking the status alone would record that as delivered.
  it('treats HTTP 200 with ok:false as a failure', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'bot was blocked by the user' }) }));
    const fallback = new MockNotifier();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await new TelegramNotifier('TOKEN', '123', fallback).send(alert);
    expect(fallback.sent).toHaveLength(1);
  });

  // 4096 characters is Telegram's hard limit; a detail blob past it would take the whole alert
  // down rather than just being clipped.
  it('truncates an oversized detail blob', async () => {
    const f = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const huge: Alert = { ...alert, detail: { blob: 'x'.repeat(50000) } };
    await new TelegramNotifier('TOKEN', '123').send(huge);
    expect(JSON.parse(f.mock.calls[0][1].body).text.length).toBeLessThan(4096);
  });
});
