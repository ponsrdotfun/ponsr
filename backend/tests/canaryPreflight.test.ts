import { executableDeployment, deploymentById } from '../src/deployments';
import { resolveCanaryPair, CanaryPairDeps } from '../src/canaryPreflight';
import { splitterArtifactFor, splitterEscrowFor } from '../src/splitterDeployer';

/**
 * What the canary must settle BEFORE it spends anything.
 *
 * The order was wrong in a way that costs money exactly once:
 *
 *   dry run   returned before `PAIR_WITH` was ever resolved, so the run whose whole
 *             purpose is to find problems could not find this one;
 *   execute   deployed the FeeSplitter first and resolved the pair afterwards.
 *
 * So an invalid or revoked stock pair produced a deployed, paid-for splitter bound to a
 * launch that then refused to happen. The script even said so -- "the splitter above is
 * deployed but unused" -- which is an accurate description of money already spent.
 *
 * Extracted here as a function rather than left inline, because a preflight that can only
 * be exercised by running a script that broadcasts is a preflight nobody tests.
 */

const D = executableDeployment();
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const NATIVE = '0x0000000000000000000000000000000000000000';

function deps(over: Partial<CanaryPairDeps> = {}): CanaryPairDeps {
  return {
    deployment: D,
    supportsPairing: true,
    resolve: async () => ({
      ok: true,
      asset: { address: AAPL, symbol: 'AAPL', name: 'Apple', decimals: 18, graduationThreshold: null },
    }),
    isApprovedNow: async () => true,
    ...over,
  };
}

describe('the canary settles its pairing before anything durable', () => {
  it('defaults to ETH when nothing was asked for', async () => {
    const r = await resolveCanaryPair(undefined, deps());
    expect(r.asset.address.toLowerCase()).toBe(NATIVE);
    expect(r.asset.symbol).toBe('ETH');
  });

  /**
   * ETH needs no approval -- the factory's gate short-circuits on the zero address, and
   * `approvedPairTokens(0x0)` is false. Asking would refuse the one pairing that always
   * works, and it would also be a pointless RPC on every default run.
   */
  it('asks nothing about approval for the ETH default', async () => {
    let asked = false;
    await resolveCanaryPair(undefined, deps({ isApprovedNow: async () => { asked = true; return false; } }));
    expect(asked).toBe(false);
  });

  it('resolves a requested asset through the registry', async () => {
    const r = await resolveCanaryPair('AAPL', deps());
    expect(r.asset.symbol).toBe('AAPL');
  });

  /** The dry-run case the old ordering could not reach at all. */
  it('refuses an unresolvable asset', async () => {
    await expect(
      resolveCanaryPair('NOPE', deps({ resolve: async () => ({ ok: false, detail: 'not approved' }) as never }))
    ).rejects.toThrow(/NOPE|not approved/i);
  });

  it('refuses a cached-approved asset that the factory has since revoked', async () => {
    // The registry caches for an hour; pons revokes. RIVN was approved and then revoked.
    await expect(
      resolveCanaryPair('AAPL', deps({ isApprovedNow: async () => false }))
    ).rejects.toThrow(/no longer approved|revoked|approval/i);
  });

  it('refuses when the approval cannot be read at all', async () => {
    // "I could not check" is not "it is fine". This is the run that spends real money.
    await expect(
      resolveCanaryPair('AAPL', deps({
        isApprovedNow: async () => { throw new Error('RPC unavailable'); },
      }))
    ).rejects.toThrow(/could not|unavailable/i);
  });

  it('refuses a pairing request on a target that cannot pair', async () => {
    await expect(
      resolveCanaryPair('AAPL', deps({ supportsPairing: false }))
    ).rejects.toThrow(/pairing|launch config/i);
  });

  it('still allows the ETH default on a target that cannot pair', async () => {
    const r = await resolveCanaryPair(undefined, deps({ supportsPairing: false }));
    expect(r.asset.address.toLowerCase()).toBe(NATIVE);
  });

  it('names the deployment it checked, so a refusal is actionable', async () => {
    try {
      await resolveCanaryPair('AAPL', deps({ isApprovedNow: async () => false }));
      throw new Error('should have refused');
    } catch (e: unknown) {
      expect(String((e as Error).message)).toContain(D.id);
    }
  });
});

/**
 * The durable artifact must follow the SELECTED deployment.
 *
 * `deploySplitter` was called without its sixth argument, so it fell back to
 * `executableDeployment()`. Under rollback or an injected target, identity, readiness and
 * calldata followed `selected` while the splitter's immutable escrow followed something
 * else -- and the escrow is the one that cannot be repaired afterwards.
 */
describe('the splitter follows the selected deployment, not the default', () => {
  it('a rollback deployment yields the v1 splitter and the v1 fee model', () => {
    const v1 = deploymentById('pons-v1');
    expect(splitterArtifactFor(v1).name).toBe('FeeSplitter');
    expect(splitterEscrowFor(v1).toLowerCase()).toBe(v1.feeEscrow.toLowerCase());
  });

  it('and differs from what the default would have produced', () => {
    const v1 = deploymentById('pons-v1');
    expect(splitterArtifactFor(v1).name).not.toBe(splitterArtifactFor(D).name);
    expect(splitterEscrowFor(v1).toLowerCase()).not.toBe(splitterEscrowFor(D).toLowerCase());
  });

  it('the canary passes its selected deployment through', () => {
    const fs = require('fs');
    const path = require('path');
    const code: string = fs
      .readFileSync(path.join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l: string) => !l.trim().startsWith('//'))
      .join('\n');
    // `selected` must be passed. Omitting it falls back to module-global selection, so
    // under rollback the identity, readiness and calldata follow `selected` while the
    // splitter's IMMUTABLE escrow follows something else -- the one that cannot be repaired.
    //
    // It used to require `selected` be the LAST argument, which broke the moment journal
    // hooks were added after it. A positional assertion protects a position; this protects
    // the argument.
    // Read the argument list rather than matching across it.
    //
    // This began as one long-range regex requiring `selected` to sit a bounded distance
    // after `provider` AND be the last argument. Journal hooks after `selected` broke it,
    // and the replacement carried a literal BACKSPACE byte where a word boundary was
    // intended -- written by a Python heredoc that ate the escape, and invisible in every
    // terminal that displayed the line. The same class of defect as the NUL byte that
    // once made a policy digest disagree with itself.
    //
    // A sentinel over source text should be simple enough that it cannot hide a byte.
    // The executable coverage is in canaryRecoverAll.test.ts.
    const open = code.indexOf('deploySplitter(');
    const args = code.slice(open + 'deploySplitter('.length, code.indexOf('{', open));
    expect(args).toContain('provider');
    expect(args).toContain('selected');
  });
});
