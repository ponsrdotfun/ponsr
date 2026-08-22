import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { Db } from '../src/db';
import { recoverLaunchIncidents } from '../src/incidentRecovery';
import { executableDeployment } from '../src/deployments';
import { PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';

const D = executableDeployment();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-recovery-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32);
const FEE = 500_000_000_000_000n;

function setup(name: string) {
  const db = new Db(path.join(TMP, name + '.sqlite'));
  db.claimTweetForProcessing(name);
  db.insertLaunch({ id: 'launch_' + name, sourceTweetId: name, xUserId: 'u1', tokenName: 'Moon',
    tokenSymbol: 'MOON', splitterAddress: SPLITTER, tokenAddress: TOKEN, txHash: TX,
    status: 'incident', rejectionReason: null, feeWeiPaid: FEE.toString(), createdAt: new Date().toISOString() });
  db.recordLaunchProvenance('launch_' + name, { deploymentId: D.id, factory: D.factory,
    feeEscrow: D.feeEscrow, chainId: D.chainId, originalDeployer: TREASURY,
    pairToken: ethers.ZeroAddress, launchConfigId: '0', salt: '0x' + '12'.repeat(32),
    economicsDigest: '0x' + '34'.repeat(32), curve: null, splitter: SPLITTER,
    launchSelector: D.launchSelector, tokenParamsVersion: D.tokenParamsVersion });
  db.recordTreasurySpend('launch_' + name, FEE);
  return db;
}

function receipt(address = D.factory) {
  const event = new ethers.Interface(PONS_V2_CURRENT_ABI).encodeEventLog('TokenLaunched',
    [TOKEN, CURVE, TREASURY, ethers.ZeroAddress, 0n, 0n]);
  return { status: 1, logs: [{ address, topics: event.topics, data: event.data }] };
}

function launchStatus(db: Db, id: string): string {
  return ((db as any).db.prepare('SELECT status FROM launches WHERE id = ?').get(id) as any).status;
}

it('keylessly promotes an incident only after full confirmation succeeds', async () => {
  const db = setup('ok');
  const receiptReads: string[] = [];
  const factoryReads: Array<[string, string]> = [];
  try {
    const result = await recoverLaunchIncidents({ db, resolveDeployment: (id) => id === D.id ? D : null,
      readReceipt: async (hash) => { receiptReads.push(hash); return receipt(); },
      readLaunchRecord: async (deployment, token) => { factoryReads.push([deployment.id, token]); return {
        token: TOKEN, curve: CURVE, deployer: TREASURY, creatorFeeRecipient: SPLITTER,
        pairToken: ethers.ZeroAddress, exists: true,
      }; },
    });
    expect(result).toEqual([{ launchId: 'launch_ok', confirmed: true, problems: [] }]);
    expect(launchStatus(db, 'launch_ok')).toBe('confirmed');
    expect(receiptReads).toEqual([TX]);
    expect(factoryReads).toEqual([[D.id, TOKEN]]);
    expect(db.totalSpendLast24h()).toBe(FEE);
  } finally { db.close(); }
});

it('stays incident and stores the reason when selected-factory evidence fails', async () => {
  const db = setup('bad');
  try {
    const result = await recoverLaunchIncidents({ db, resolveDeployment: () => D,
      readReceipt: async () => receipt('0x8888888888888888888888888888888888888888'),
      readLaunchRecord: async () => { throw new Error('must not read a foreign token'); },
    });
    expect(result[0].confirmed).toBe(false);
    expect(result[0].problems.join(' ')).toMatch(/selected factory/i);
    expect(launchStatus(db, 'launch_bad')).toBe('incident');
    expect(db.getIncidentReason('launch_bad')).toMatch(/selected factory/i);
    expect(db.totalSpendLast24h()).toBe(FEE);
  } finally { db.close(); }
});

it('is idempotent: a confirmed incident is not read or accounted twice', async () => {
  const db = setup('twice');
  const readReceipt = jest.fn(async () => receipt());
  const readLaunchRecord = jest.fn(async () => ({ token: TOKEN, curve: CURVE, deployer: TREASURY,
    creatorFeeRecipient: SPLITTER, pairToken: ethers.ZeroAddress, exists: true }));
  try {
    const deps = { db, resolveDeployment: () => D, readReceipt, readLaunchRecord };
    await recoverLaunchIncidents(deps);
    expect(await recoverLaunchIncidents(deps)).toEqual([]);
    expect(readReceipt).toHaveBeenCalledTimes(1);
    expect(readLaunchRecord).toHaveBeenCalledTimes(1);
    expect(db.totalSpendLast24h()).toBe(FEE);
  } finally { db.close(); }
});

it('has no signer or send dependency in its keyless interface', async () => {
  const db = setup('keyless');
  try {
    await recoverLaunchIncidents({ db, resolveDeployment: () => D,
      readReceipt: async () => null, readLaunchRecord: async () => null });
    expect(launchStatus(db, 'launch_keyless')).toBe('incident');
  } finally { db.close(); }
});
