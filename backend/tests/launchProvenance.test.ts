import * as fs from 'fs';
import { Db } from '../src/db';

const P = './data/test-provenance.sqlite';
function fresh(): Db {
  if (fs.existsSync(P)) fs.unlinkSync(P);
  return new Db(P);
}

/**
 * Which deployment a launch was made through, recorded at the time.
 *
 * Ponsr has launched through three pons deployments now, and they differ in ways that
 * matter when reading a row back: different ABIs, different event shapes, different
 * escrows. A record that says only "a token was launched" cannot tell you which
 * contract to ask about it, and after the next migration nobody will remember.
 *
 * The old rows predate all of this and must stay readable. Reinterpreting them as
 * current-deployment launches would attribute them to a factory that did not exist
 * when they were made.
 */
describe('launch provenance', () => {
  let db: Db;
  beforeEach(() => { db = fresh(); });
  afterEach(() => db.close());

  it('records the deployment a launch was built for', () => {
    db.claimTweetForProcessing('t1');
    db.insertLaunch({
      id: 'l1', sourceTweetId: 't1', xUserId: 'u1',
      tokenName: 'A', tokenSymbol: 'AAA', status: 'pending', createdAt: new Date().toISOString(),
      splitterAddress: null, tokenAddress: null, txHash: null, rejectionReason: null, feeWeiPaid: null,
    } as any);
    db.recordLaunchProvenance('l1', {
      deploymentId: 'pons-v2-current-7ed',
      factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
      feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
      chainId: 4663,
      originalDeployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      pairToken: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
      launchConfigId: '0',
      salt: '0x' + 'cd'.repeat(32),
      economicsDigest: '0x' + 'ab'.repeat(32),
      curve: '0x' + '22'.repeat(20),
    });

    const p = db.getLaunchProvenance('l1')!;
    expect(p.deploymentId).toBe('pons-v2-current-7ed');
    expect(p.feeEscrow.toLowerCase()).toBe('0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e');
    expect(p.salt).toBe('0x' + 'cd'.repeat(32));
    expect(p.chainId).toBe(4663);
  });

  // A row written before the registry existed is not a current-deployment launch and
  // must not be reported as one.
  it('leaves a pre-migration row with no deployment rather than guessing', () => {
    db.claimTweetForProcessing('t_old');
    db.insertLaunch({
      id: 'old', sourceTweetId: 't_old', xUserId: 'u1',
      tokenName: 'Old', tokenSymbol: 'OLD', status: 'confirmed', createdAt: new Date().toISOString(),
      splitterAddress: null, tokenAddress: null, txHash: null, rejectionReason: null, feeWeiPaid: null,
    } as any);
    expect(db.getLaunchProvenance('old')).toBeNull();
  });

  it('keeps the original row readable alongside its provenance', () => {
    db.claimTweetForProcessing('t2');
    db.insertLaunch({
      id: 'l2', sourceTweetId: 't2', xUserId: 'u2',
      tokenName: 'B', tokenSymbol: 'BBB', status: 'pending', createdAt: new Date().toISOString(),
      splitterAddress: null, tokenAddress: null, txHash: null, rejectionReason: null, feeWeiPaid: null,
    } as any);
    db.recordLaunchProvenance('l2', {
      deploymentId: 'pons-v1', factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
      feeEscrow: '0x736D76699C26D0d966744cAe304C000d471f7F35', chainId: 4663,
      originalDeployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      pairToken: '0x0000000000000000000000000000000000000000',
      launchConfigId: '0', salt: '0x' + '00'.repeat(32), economicsDigest: null, curve: null,
    });
    db.updateLaunchStatus('l2', 'confirmed', { tokenAddress: '0x' + '44'.repeat(20) });
    const p = db.getLaunchProvenance('l2')!;
    expect(p.deploymentId).toBe('pons-v1');
    expect(p.economicsDigest).toBeNull();
  });

  // Opening an older database must add the table rather than refuse or rewrite rows.
  it('migrates an existing database without touching its rows', () => {
    db.claimTweetForProcessing('t3');
    db.insertLaunch({
      id: 'l3', sourceTweetId: 't3', xUserId: 'u3',
      tokenName: 'C', tokenSymbol: 'CCC', status: 'confirmed', createdAt: new Date().toISOString(),
      splitterAddress: null, tokenAddress: null, txHash: null, rejectionReason: null, feeWeiPaid: null,
    } as any);
    db.close();
    const reopened = new Db(P);
    expect(reopened.getLaunchProvenance('l3')).toBeNull();
    reopened.close();
    db = new Db(P);
  });
});
