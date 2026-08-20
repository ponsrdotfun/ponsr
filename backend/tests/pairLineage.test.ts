import { discoverPairAssets, PairTokenSource } from '../src/pairTokens';
import { executableDeployment, deploymentById } from '../src/deployments';

/**
 * Approvals belong to the deployment that emitted them.
 *
 * The superseded factory approved eight assets. The current one approves twenty-three
 * and has already revoked one. Carrying the old snapshot forward would have offered a
 * set that is both too small and, for anything revoked, wrong -- and "wrong" here means
 * a launch that reverts after the splitter is deployed and paid for.
 */
describe('pair approvals follow the deployment', () => {
  const current = executableDeployment();
  const legacy = deploymentById('pons-v2-legacy-7e1');

  it('scans from the deployment’s own start block, not from an arbitrary one', () => {
    // Below its creation there is nothing to find; above it, approvals are missed
    // silently, which reads exactly like pons never having granted them.
    expect(current.startBlock).toBe(26_841_846);
    expect(legacy.startBlock).toBeLessThan(current.startBlock);
  });

  // A revocation on the current deployment must win, and the live check is what makes
  // certain of it: history can be read short, the current state cannot.
  it('honours a revocation and re-checks it live', async () => {
    const REVOKED = '0x' + 'r1'.replace('r', 'a').repeat(20);
    const source: PairTokenSource = {
      approvalHistory: async () => [
        { pairToken: REVOKED, approved: true, blockNumber: 35_992_050, logIndex: 0 },
        { pairToken: REVOKED, approved: false, blockNumber: 36_038_218, logIndex: 0 },
      ],
      tokenMeta: async () => ({ symbol: 'RIVN', name: 'Rivian', decimals: 18 }),
      economics: async () => ({ graduationThreshold: 1n, decimals: 18 }),
      isApproved: async () => false,
    };
    expect(await discoverPairAssets(source)).toEqual([]);
  });

  // The live check is the authority even when history says otherwise, because a
  // shortened scan and a genuine revocation are indistinguishable from the log alone.
  it('drops an asset the log approved but the live factory does not', async () => {
    const A = '0x' + 'aa'.repeat(20);
    const source: PairTokenSource = {
      approvalHistory: async () => [{ pairToken: A, approved: true, blockNumber: 1, logIndex: 0 }],
      tokenMeta: async () => ({ symbol: 'GONE', name: 'Gone', decimals: 18 }),
      economics: async () => ({ graduationThreshold: 1n, decimals: 18 }),
      isApproved: async () => false,
    };
    expect(await discoverPairAssets(source)).toEqual([]);
  });
});

/**
 * Which ABI the pair scanner decodes with.
 *
 * The address passed in has been the current factory since the registry landed, but the
 * decoding used `abi/ponsV2LaunchFactory.json` -- the SUPERSEDED deployment's artifact,
 * loaded by a module-level import that no address check can see.
 *
 * It happens to work: `PairTokenApprovalUpdated` and `PairTokenEconomicsUpdated` are
 * byte-identical across both deployments, verified rather than assumed. That is exactly
 * what makes it worth fixing before it stops being true. pons has already changed
 * `TokenParams` between these two factories; an approval event is no more permanent, and
 * the failure would be a silently mis-decoded approval rather than an error.
 */
describe('the pair scanner decodes with the deployment it is scanning', () => {
  it('binds the executable deployment’s ABI, not the superseded artifact', () => {
    const fs = require('fs');
    const path = require('path');
    const code: string = fs.readFileSync(path.join(__dirname, '../src/pairTokenSource.ts'), 'utf8');
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l: string) => !l.trim().startsWith('//'))
      .join('\n');
    expect(stripped).not.toMatch(/from '\.\/abi\/ponsV2LaunchFactory\.json'/);
  });

  it('the two approval events really are identical, which is why this was invisible', () => {
    const { ethers } = require('ethers');
    const sigs = (file: string) =>
      new ethers.Interface(require(`../src/abi/${file}`)).fragments
        .filter((f: any) => f.type === 'event' && /Pair/.test(f.name))
        .map((f: any) => f.format('sighash'))
        .sort();
    expect(sigs('ponsV2LaunchFactory.json')).toEqual(sigs('ponsV2CurrentLaunchFactory.json'));
  });
});
