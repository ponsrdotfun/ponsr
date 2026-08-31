/**
 * A CLAIM IS A WRITE, AND IS GUARDED LIKE ONE.
 *
 * Each accepted call spends the treasury's gas. An attacker who cannot steal --
 * `claimAndSplit` always pays the creator -- can still make Ponsr pay to do
 * nothing, repeatedly, so this route needs every guard a write needs rather
 * than the ones a read would have.
 *
 * Driven through a real express server on an ephemeral port, the way the other
 * account route tests here are, so the middleware order and the cookie parsing
 * are exercised rather than assumed.
 */
import express from 'express';
import { AddressInfo } from 'net';
import { accountRouter } from '../src/accountRoutes';

const WALLET = '0xcdce6c82D995d3223D4e956A3C28D36BaD875dc0';
const ORIGIN = 'https://ponsr.fun';
const ERC20 = '0x' + 'd'.repeat(40);

describe('POST /api/account/claim', () => {
  let server: any, base: string, claimCalls: any[];

  const boot = async (opts: { session?: any; claim?: any } = {}) => {
    claimCalls = [];
    const auth: any = {
      readiness: () => true,
      siteOrigin: () => ORIGIN,
      assertOrigin: (o: string) => { if (o !== ORIGIN) throw new Error('origin rejected'); },
      session: (t?: string) =>
        opts.session ?? (t === 'good'
          ? { state: 'authenticated', identity: { xUserId: 'user_1' }, wallet: { address: WALLET } }
          : { state: 'unauthenticated' }),
      launches: () => ({ state: 'unauthenticated' }),
      wallet: () => ({ state: 'unauthenticated' }),
      logout: () => false,
    };
    const claims: any = {
      claim: async (input: any) => {
        claimCalls.push(input);
        return opts.claim ? opts.claim(input) : { state: 'sent', hash: '0x' + 'a'.repeat(64) };
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', accountRouter(auth, claims));
    await new Promise<void>((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); server = undefined; });

  const post = (headers: Record<string, string>) =>
    fetch(`${base}/api/account/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify({ launchId: 'launch_1', erc20: ERC20 }),
    });

  const signedIn = { cookie: '__Host-ponsr_session=good; __Host-ponsr_csrf=tok', 'x-csrf-token': 'tok' };

  it('sends the claim for an authenticated caller with a matching CSRF token', async () => {
    await boot();
    const res = await post(signedIn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).state).toBe('sent');
    // The identity reaching the service comes from the SESSION, not the body.
    expect(claimCalls[0].xUserId).toBe('user_1');
    expect(claimCalls[0].wallet).toBe(WALLET);
  });

  it('refuses without a session, before any claim work happens', async () => {
    await boot();
    const res = await post({ 'x-csrf-token': 'tok' });
    expect(res.status).toBe(401);
    expect(claimCalls).toHaveLength(0);
  });

  it('refuses a mismatched CSRF token, so another page cannot spend the gas', async () => {
    await boot();
    const res = await post({ ...signedIn, 'x-csrf-token': 'wrong' });
    expect(res.status).toBe(403);
    expect(claimCalls).toHaveLength(0);
  });

  it('refuses a foreign origin', async () => {
    await boot();
    const res = await fetch(`${base}/api/account/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...signedIn },
      body: JSON.stringify({ launchId: 'launch_1', erc20: ERC20 }),
    });
    expect(res.status).toBe(403);
    expect(claimCalls).toHaveLength(0);
  });

  it('reports a signer refusal as 503, not 500', async () => {
    // The operator can change a policy; this request was not at fault, and the
    // status code is what tells a monitor which of those two it is looking at.
    await boot({ claim: () => ({ state: 'signer-refused', detail: 'policy' }) });
    const res = await post(signedIn);
    expect(res.status).toBe(503);
  });

  it('reports somebody else\u2019s launch as 403', async () => {
    await boot({ claim: () => ({ state: 'not-yours' }) });
    expect((await post(signedIn)).status).toBe(403);
  });

  it('rate limits, because every accepted call spends gas', async () => {
    await boot();
    const codes: number[] = [];
    for (let i = 0; i < 15; i += 1) codes.push((await post(signedIn)).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});
