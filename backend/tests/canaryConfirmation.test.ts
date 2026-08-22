import { ethers } from 'ethers';
import { confirmCanaryLaunch } from '../src/canaryConfirmation';
import { executableDeployment, PonsDeployment } from '../src/deployments';
import { buildCurrentV2LaunchCalldata, launchSalt, PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';

const SELECTED = executableDeployment();
const FOREIGN: PonsDeployment = { ...SELECTED, id: 'foreign', factory: '0x8888888888888888888888888888888888888888' };
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const NATIVE = ethers.ZeroAddress;
const FEE = 500_000_000_000_000n;

function fixture() {
  const tx = buildCurrentV2LaunchCalldata({
    tokenName: 'Canary', tokenSymbol: 'CNY', logo: '', description: '',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    feeWallet: SPLITTER, launchConfigId: 0n, pairToken: NATIVE, creatorTaxBps: 0,
    buybackEnabled: false, expectedEconomics: '0x' + 'ab'.repeat(32),
    salt: launchSalt(SELECTED, 'canary'),
  }, FEE, SELECTED);
  const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);
  const event = iface.encodeEventLog('TokenLaunched', [TOKEN, CURVE, TREASURY, NATIVE, 0n, 0n]);
  return { tx, logs: [{ address: SELECTED.factory, topics: event.topics, data: event.data }] };
}

it('fully confirms exact calldata, selected-factory receipt, launched-token record and splitter', async () => {
  const { tx, logs } = fixture();
  const reads: Array<[string, string]> = [];
  const result = await confirmCanaryLaunch({
    selected: SELECTED, outgoing: tx, splitterAddress: SPLITTER, treasuryAddress: TREASURY,
    receipt: { status: 1, logs },
    readLaunchRecord: async (deployment, token) => {
      reads.push([deployment.id, token]);
      return { token: TOKEN, curve: CURVE, deployer: TREASURY, creatorFeeRecipient: SPLITTER, pairToken: NATIVE, exists: true };
    },
  });
  expect(result.verdict).toEqual({ ok: true, problems: [] });
  expect(result.token).toBe(TOKEN);
  expect(reads).toEqual([[SELECTED.id, TOKEN]]);
});

it('rejects calldata addressed anywhere except the selected deployment', async () => {
  const { tx, logs } = fixture();
  await expect(confirmCanaryLaunch({
    selected: SELECTED, outgoing: { ...tx, to: FOREIGN.factory }, splitterAddress: SPLITTER,
    treasuryAddress: TREASURY, receipt: { status: 1, logs }, readLaunchRecord: async () => null,
  })).rejects.toThrow(/selected deployment/i);
});

it('ignores a valid-looking event from a foreign factory and never reads its token', async () => {
  const { tx, logs } = fixture();
  const read = jest.fn();
  const result = await confirmCanaryLaunch({
    selected: SELECTED, outgoing: tx, splitterAddress: SPLITTER, treasuryAddress: TREASURY,
    receipt: { status: 1, logs: [{ ...logs[0], address: FOREIGN.factory }] }, readLaunchRecord: read,
  });
  expect(result.verdict.ok).toBe(false);
  expect(result.verdict.problems.join(' ')).toMatch(/selected factory/i);
  expect(read).not.toHaveBeenCalled();
});

it('fails full confirmation when getLaunchedToken names another creator recipient', async () => {
  const { tx, logs } = fixture();
  const result = await confirmCanaryLaunch({
    selected: SELECTED, outgoing: tx, splitterAddress: SPLITTER, treasuryAddress: TREASURY,
    receipt: { status: 1, logs },
    readLaunchRecord: async () => ({ token: TOKEN, curve: CURVE, deployer: TREASURY,
      creatorFeeRecipient: FOREIGN.factory, pairToken: NATIVE, exists: true }),
  });
  expect(result.verdict.ok).toBe(false);
  expect(result.verdict.problems.join(' ')).toMatch(/creator fee recipient/i);
});

it('requires a successful receipt', async () => {
  const { tx, logs } = fixture();
  const result = await confirmCanaryLaunch({
    selected: SELECTED, outgoing: tx, splitterAddress: SPLITTER, treasuryAddress: TREASURY,
    receipt: { status: 0, logs }, readLaunchRecord: async () => null,
  });
  expect(result.verdict.ok).toBe(false);
  expect(result.verdict.problems.join(' ')).toMatch(/receipt/i);
});

it('the operator canary uses full confirmation and prints the pinned collector command', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8');
  expect(source).toContain('confirmCanaryLaunch({');
  expect(source).toContain('npm run collect:v2 --');
  expect(source).not.toContain('npx tsx scripts/collect-and-split-v2.ts');
});

it('does not consult a global factory version or reselect deployment after selected exists', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8');
  const afterSelection = source.slice(source.indexOf('const selected = target.deployment'));
  expect(afterSelection).not.toContain('PONS_FACTORY_VERSION');
  expect(afterSelection).not.toContain('executableDeployment(');
});
