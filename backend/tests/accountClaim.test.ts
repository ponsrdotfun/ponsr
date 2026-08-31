/**
 * CLAIMING SOMEBODY ELSE'S FEES MUST BE IMPOSSIBLE, AND CHEAP TO REFUSE.
 *
 * `claimAndSplit` pays the creator whoever calls it, so a wrong claim cannot
 * steal. What it CAN do is spend the treasury's gas on a stranger, repeatedly,
 * for anyone who guesses a token address -- so ownership is read from the session
 * and never from the request, and the splitter's own `creator()` is re-read
 * from chain before a single wei of gas is committed.
 */
import { ethers } from 'ethers';
import { AccountClaimService } from '../src/accountClaim';

const SPLITTER = '0x18d1d206A042260aA86F2aF87a8bf7c959f899D5';
const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const WALLET = '0xcdce6c82D995d3223D4e956A3C28D36BaD875dc0';
const STRANGER = '0x1111111111111111111111111111111111111111';
const ERC20 = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
/** Microduck, whose splitter is the one above. */
const TOKEN = '0xC9158abF265aa26766154269f9B3D417f7771d0A';

const encodedAddress = (a: string) => `0x${a.toLowerCase().replace('0x', '').padStart(64, '0')}`;
const encodedUint = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

function deps(overrides: any = {}) {
  const sent: any[] = [];
  const base = {
    db: {
      // The column names mirror db.ts's own aliases. A mock that invented a
      // different shape would only report this test's expectations back.
      listLaunchesForUser: (id: string) =>
        id === 'user_1' ? [{ id: 'launch_1', tokenAddress: TOKEN }] : [],
      getLaunchProvenance: () => ({ splitter: SPLITTER, feeEscrow: ESCROW }),
    },
    provider: {
      call: async ({ data }: any) =>
        data.startsWith(ethers.id('creator()').slice(0, 10))
          ? encodedAddress(WALLET)
          : encodedUint(20524420520164638n),
    },
    signer: {
      sendTransaction: async (tx: any) => {
        sent.push(tx);
        return { hash: '0x' + 'a'.repeat(64), wait: async () => ({} as any) };
      },
    },
    ...overrides,
  };
  return { deps: base as any, sent };
}

const ok = { xUserId: 'user_1', wallet: WALLET, token: TOKEN, erc20: ERC20 };

describe('AccountClaimService', () => {
  it('sends the claim for a launch the signed-in identity owns', async () => {
    const { deps: d, sent } = deps();
    const result = await new AccountClaimService(d).claim(ok);
    expect(result.state).toBe('sent');
    expect(sent).toHaveLength(1);
    // The call goes to the SPLITTER, carries no value, and names the asset.
    expect(sent[0].to).toBe(SPLITTER);
    expect(sent[0].value).toBe(0n);
    expect(sent[0].data.startsWith(ethers.id('claimAndSplit(address)').slice(0, 10))).toBe(true);
    expect(sent[0].data.toLowerCase()).toContain(ERC20.slice(2).toLowerCase());
  });

  it('refuses a launch the signed-in identity does not own, without spending gas', async () => {
    const { deps: d, sent } = deps();
    const result = await new AccountClaimService(d).claim({ ...ok, token: '0x' + 'b'.repeat(40) });
    expect(result.state).toBe('not-yours');
    expect(sent).toHaveLength(0);
  });

  it('takes the identity from the session, never from the request', async () => {
    const { deps: d, sent } = deps();
    // No session identity at all: a launch id alone must never be enough.
    const result = await new AccountClaimService(d).claim({ token: TOKEN, erc20: ERC20 });
    expect(result.state).toBe('unauthenticated');
    expect(sent).toHaveLength(0);
  });

  it('refuses when the splitter on chain pays somebody else', async () => {
    const { deps: d, sent } = deps({
      provider: { call: async ({ data }: any) =>
        data.startsWith(ethers.id('creator()').slice(0, 10)) ? encodedAddress(STRANGER) : encodedUint(1n) },
    });
    const result = await new AccountClaimService(d).claim(ok);
    expect(result.state).toBe('wallet-mismatch');
    expect(sent).toHaveLength(0);
  });

  it('refuses a zero balance rather than burning gas to learn it reverts', async () => {
    const { deps: d, sent } = deps({
      provider: { call: async ({ data }: any) =>
        data.startsWith(ethers.id('creator()').slice(0, 10)) ? encodedAddress(WALLET) : encodedUint(0n) },
    });
    const result = await new AccountClaimService(d).claim(ok);
    expect(result.state).toBe('nothing-to-claim');
    expect(sent).toHaveLength(0);
  });

  it('reports a signer policy refusal AS a refusal, not as a generic failure', async () => {
    const { deps: d } = deps({
      signer: { sendTransaction: async () => { throw new Error('Turnkey: request denied by policy engine'); } },
    });
    const result: any = await new AccountClaimService(d).claim(ok);
    // Until a policy permits calls to splitter addresses, every claim is denied.
    // Saying so is what sends an operator to the policy rather than to this file.
    expect(result.state).toBe('policy-refused');
    expect(result.detail).toMatch(/policy/i);
  });

  it('does not mistake a network failure for a policy refusal', async () => {
    const { deps: d } = deps({
      signer: { sendTransaction: async () => { throw new Error('ECONNRESET'); } },
    });
    const result: any = await new AccountClaimService(d).claim(ok);
    expect(result.state).toBe('unavailable');
  });

  it('matches the token whatever case it arrives in', async () => {
    // Chain reads come back lowercase and the database stores what the launch
    // wrote. A comparison that respected case would refuse a real owner their
    // own launch, and refuse it as "not yours".
    const { deps: d } = deps();
    const result = await new AccountClaimService(d).claim({ ...ok, token: TOKEN.toLowerCase() });
    expect(result.state).toBe('sent');
  });

  it('refuses a launch with no recorded splitter', async () => {
    const { deps: d, sent } = deps({
      db: {
        listLaunchesForUser: () => [{ id: 'launch_1', tokenAddress: TOKEN }],
        getLaunchProvenance: () => ({ splitter: null, feeEscrow: ESCROW }),
      },
    });
    const result = await new AccountClaimService(d).claim(ok);
    expect(result.state).toBe('no-splitter');
    expect(sent).toHaveLength(0);
  });
});
