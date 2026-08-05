import { MockWalletResolver, PrivyWalletResolver, externalIdFor, generateMockWallet } from '../src/walletResolver';
import { Db } from '../src/db';
import * as fs from 'fs';

const TEST_DB_PATH = './data/test-wallets.sqlite';
function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

describe('externalIdFor -- the second idempotency guarantee', () => {
  it('is stable for one X user', () => {
    expect(externalIdFor('123')).toBe(externalIdFor('123'));
  });

  it('differs between users', () => {
    expect(externalIdFor('123')).not.toBe(externalIdFor('124'));
  });

  it('stays inside Privy constraints: URL-safe, 64 chars max', () => {
    // Privy rejects anything else, and it rejects at wallet-creation time -- which is
    // mid-launch, after the treasury has already been committed to spending.
    const id = externalIdFor('x'.repeat(200) + '!!@@##');
    expect(id.length).toBeLessThanOrEqual(64);
    expect(/^[a-zA-Z0-9_-]+$/.test(id)).toBe(true);
  });
});

describe('PrivyWalletResolver', () => {
  let db: Db;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('returns the stored wallet without calling Privy at all', async () => {
    // The DB is the fast path. A user who already has a wallet must never trigger a
    // create call -- that is what makes a repeat launch cheap and, more importantly,
    // what keeps a provider outage from breaking users who are already onboarded.
    const resolver = new PrivyWalletResolver(db, '', ''); // unconfigured on purpose
    const wallet = generateMockWallet('user_1');
    db.upsertUser('user_1', 'someone', {
      xUserId: 'user_1', walletAddress: wallet.address, providerRef: wallet.providerRef,
    });

    const resolved = await resolver.resolve('user_1', 'someone');
    expect(resolved.walletAddress).toBe(wallet.address);
  });

  it('CRITICAL: refuses to run unconfigured rather than inventing a wallet', async () => {
    // A resolver that silently fell back to generating a local key would hand a user an
    // address whose private key this server holds -- the exact custody property Privy is
    // here to avoid.
    const resolver = new PrivyWalletResolver(db, '', '');
    await expect(resolver.resolve('new_user', 'nobody')).rejects.toThrow(/not configured/i);
  });
});

describe('MockWalletResolver', () => {
  let db: Db;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('is stable per user and persists the mapping', async () => {
    const resolver = new MockWalletResolver(db);
    const a = await resolver.resolve('u1', 'handle');
    const b = await resolver.resolve('u1', 'handle');
    expect(a.walletAddress).toBe(b.walletAddress);
    expect(db.getUser('u1')!.walletAddress).toBe(a.walletAddress);
  });

  it('gives different users different wallets', async () => {
    const resolver = new MockWalletResolver(db);
    const a = await resolver.resolve('u1', 'h1');
    const b = await resolver.resolve('u2', 'h2');
    expect(a.walletAddress).not.toBe(b.walletAddress);
  });
});
