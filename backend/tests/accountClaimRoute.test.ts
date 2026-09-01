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
const TOKEN = '0x' + 'c'.repeat(40);

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
      body: JSON.stringify({ token: TOKEN, erc20: ERC20 }),
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
      body: JSON.stringify({ token: TOKEN, erc20: ERC20 }),
    });
    expect(res.status).toBe(403);
    expect(claimCalls).toHaveLength(0);
  });

  it('reports a signer refusal as 503, not 500', async () => {
    // The operator can change a policy; this request was not at fault, and the
    // status code is what tells a monitor which of those two it is looking at.
    await boot({ claim: () => ({ state: 'policy-refused', detail: 'policy' }) });
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

/**
 * A BALANCE THAT COULD NOT BE READ IS NOT A BALANCE OF ZERO.
 *
 * The overview card says "Native balance". Zero there is a statement that the
 * reader has nothing; null is a statement that nobody could ask. This
 * repository has already shipped the first mistake twice -- an unreadable
 * launch fee became 0n and `/status` published `launchpad: ok` for a launch
 * whose price nobody had read, and an unknown rolling spend fell back to the
 * calendar day and published `daily-cap: ok`.
 */
describe('GET /api/account/wallet balance', () => {
  const WALLET_2 = '0xcdce6c82D995d3223D4e956A3C28D36BaD875dc0';
  let server: any, base: string;

  const boot = async (balanceOf?: any, authenticated = true) => {
    const express = require('express');
    const { accountRouter } = require('../src/accountRoutes');
    const app = express();
    app.use(express.json());
    const service: any = {
      readiness: () => true,
      siteOrigin: () => 'https://ponsr.fun',
      assertOrigin: () => undefined,
      wallet: () =>
        authenticated
          ? { state: 'authenticated', wallet: { address: WALLET_2 } }
          : { state: 'unauthenticated' },
    };
    app.use('/api', accountRouter(service, undefined, balanceOf));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  };

  afterEach(() => server?.close());

  it('reports a read balance', async () => {
    await boot(async () => '1234500000000000000');
    const body: any = await (await fetch(`${base}/api/account/wallet`)).json();
    expect(body.balanceWei).toBe('1234500000000000000');
  });

  it('reports null when the read throws, never zero', async () => {
    await boot(async () => {
      throw new Error('rpc unreachable');
    });
    const body: any = await (await fetch(`${base}/api/account/wallet`)).json();
    expect(body.balanceWei).toBeNull();
    expect(body.balanceWei).not.toBe('0');
    // The route must still answer: an unreadable extra cannot take the wallet
    // address down with it.
    expect(body.wallet.address).toBe(WALLET_2);
  });

  it('reports null when no reader is wired at all', async () => {
    await boot(undefined);
    const body: any = await (await fetch(`${base}/api/account/wallet`)).json();
    expect(body.balanceWei).toBeNull();
  });

  it('asks for no balance when nobody is signed in', async () => {
    let asked = 0;
    await boot(async () => {
      asked += 1;
      return '1';
    }, false);
    const response = await fetch(`${base}/api/account/wallet`);
    expect(response.status).toBe(401);
    expect(asked).toBe(0);
  });
});
