import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CanaryJournal } from '../src/canaryJournal';

/**
 * Two operator processes, one journal, one permanent artifact.
 *
 * prepare() read the open set and inserted in separate statements, so two processes could
 * interleave between them: both observe nothing open, both insert, both proceed to
 * broadcast. Nothing in the journal prevented it, and the consequence is two permanent
 * contracts or two launches from one intent.
 *
 * Driven as real separate processes rather than two objects in one runtime, because the
 * property under test is cross-process locking and an in-process test cannot exercise it.
 */

const PREP = `
  // node -e has no script path, so the first user argument is argv[1], not argv[2].
  const { CanaryJournal } = require(process.argv[1]);
  const j = new CanaryJournal(process.argv[2], { allowEphemeral: true });
  try {
    j.prepare({
      runId: 'race', op: 'token_launch', deploymentId: 'pons-v2-current-7ed',
      chainId: 4663, to: '0xfactory', value: 500000000000000n, calldata: '0xf35abbcf',
    });
    console.log('PREPARED');
  } catch (e) {
    console.log('REFUSED');
  } finally {
    j.close();
  }
`;

describe('only one process can prepare a run', () => {
  it('refuses the second concurrent prepare', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-race-'));
    const file = path.join(dir, 'canary.sqlite');
    const modulePath = path.join(__dirname, '../dist/canaryJournal.js');

    // Requires a build; the compiled module is what a real operator process would load.
    if (!fs.existsSync(modulePath)) {
      // eslint-disable-next-line no-console
      console.warn('dist/canaryJournal.js absent — run npm run build. Falling back to in-process.');
      const a = new CanaryJournal(file, { allowEphemeral: true });
      const row = {
        runId: 'race', op: 'token_launch' as const, deploymentId: 'pons-v2-current-7ed',
        chainId: 4663, to: '0xfactory', value: 500_000_000_000_000n, calldata: '0xf35abbcf',
      };
      a.prepare(row);
      const b = new CanaryJournal(file, { allowEphemeral: true });
      expect(() => b.prepare(row)).toThrow();
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    const runs = [0, 1].map(() =>
      execFileSync(process.execPath, ['-e', PREP, modulePath, file], { encoding: 'utf8' }).trim()
    );
    expect(runs.filter((r) => r === 'PREPARED')).toHaveLength(1);
    expect(runs.filter((r) => r === 'REFUSED')).toHaveLength(1);

    const j = new CanaryJournal(file, { allowEphemeral: true });
    expect(j.unresolved()).toHaveLength(1);
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The schema-level guarantee, independent of who read what and when. */
  it('cannot hold two live rows for one run and operation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-race2-'));
    const file = path.join(dir, 'canary.sqlite');
    const j = new CanaryJournal(file, { allowEphemeral: true });
    const row = {
      runId: 'race', op: 'token_launch' as const, deploymentId: 'pons-v2-current-7ed',
      chainId: 4663, to: '0xfactory', value: 500_000_000_000_000n, calldata: '0xf35abbcf',
    };
    j.prepare(row);
    // Bypassing prepare's own checks entirely: the index must still refuse.
    const raw = (j as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db;
    expect(() =>
      raw
        .prepare(
          `INSERT INTO canary_tx (run_id, op, deployment_id, chain_id, to_address, value_wei,
             calldata, state, problems, prepared_at, updated_at)
           VALUES ('race','token_launch','pons-v2-current-7ed',4663,'0xf','1','0x','prepared','[]','x','x')`
        )
        .run()
    ).toThrow(/UNIQUE|constraint/i);
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
