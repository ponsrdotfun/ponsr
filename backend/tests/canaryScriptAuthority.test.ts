import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural guarantees about the canary script that a runtime test cannot give.
 *
 * Running the script to prove it does not broadcast requires a signer, mainnet config and
 * a treasury with money in it — and a test that needs those to pass is a test nobody runs.
 * These read the source instead, which is enough for the properties that matter here:
 * ordering, and which branch a capability sits behind.
 */

const SRC = fs.readFileSync(path.join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8');
/** Comments explain the defects, and quote the strings being forbidden. Strip them. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the dry run cannot spend anything', () => {
  it('reaches sendTransaction only after the EXECUTE gate', () => {
    const gate = CODE.indexOf('if (!EXECUTE)');
    const send = CODE.indexOf('signer.sendTransaction');
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(gate);
  });

  it('reaches the splitter deployment only after the same gate', () => {
    const gate = CODE.indexOf('if (!EXECUTE)');
    const deploy = CODE.indexOf('deploySplitter(');
    expect(deploy).toBeGreaterThan(gate);
  });

  it('still defaults to dry run', () => {
    expect(CODE).toMatch(/const EXECUTE = process\.argv\.includes\('--execute'\)/);
  });
});

describe('success language is ordered behind the verdict', () => {
  /**
   * The original defect, asserted as an ordering rather than a string.
   *
   * `=== LAUNCHED ===` was printed immediately after a status=1 receipt and thirteen lines
   * before confirmCanaryLaunch ran. Every individual string was correct; only the order
   * was wrong, which is why the banners are chosen by a pure function now.
   */
  it('never hard-codes a launch success banner in the script', () => {
    expect(CODE).not.toMatch(/'=== LAUNCHED ==='/);
    expect(CODE).not.toMatch(/"=== LAUNCHED ==="/);
  });

  it('prints only what decideCanaryPhase returns', () => {
    expect(CODE).toMatch(/decideCanaryPhase\(/);
  });

  /**
   * Scoped to the LAUNCH, because the splitter legitimately confirms earlier.
   *
   * This compared the first `markConfirmed` against the first `markIncident` across the
   * whole file, and broke the moment the splitter deployment was journalled -- its confirm
   * runs long before the launch has a verdict at all. A file-wide position was never the
   * property; the property is that the LAUNCH row is confirmed only after its own
   * reconciliation. The executable version lives in canaryReporting.test.ts.
   */
  it('confirms the launch row only after its reconciliation branch', () => {
    const launchIncident = CODE.indexOf('journal.markIncident(launchRowId');
    const launchConfirmed = CODE.indexOf('journal.markConfirmed(launchRowId');
    expect(launchIncident).toBeGreaterThan(-1);
    expect(launchConfirmed).toBeGreaterThan(launchIncident);
  });
});

describe('irreversible actions are journalled before they can happen', () => {
  it('prepares the journal row before the launch is sent', () => {
    const prepare = CODE.indexOf("op: 'token_launch'");
    const send = CODE.indexOf('signer.sendTransaction');
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(send);
  });

  it('binds the transaction hash before awaiting the receipt', () => {
    const bind = CODE.indexOf('journal.bindHash(');
    const wait = CODE.indexOf('await sent.wait()');
    expect(bind).toBeGreaterThan(-1);
    expect(bind).toBeLessThan(wait);
  });

  it('refuses to start while the journal holds unresolved work', () => {
    expect(CODE).toMatch(/journal\.unresolved\(\)/);
    const check = CODE.indexOf('journal.unresolved()');
    const send = CODE.indexOf('signer.sendTransaction');
    expect(check).toBeLessThan(send);
  });
});

describe('the journal is durable operator state, not container scratch', () => {
  /**
   * `allowEphemeral` exists because the durability guard caught this project's own tests:
   * on Linux `os.tmpdir()` IS `/tmp`, so every journal test failed in CI while passing on
   * Windows. That is the guard biting, not a reason to soften it -- and the escape hatch
   * must stay in the tests that need it.
   */
  it('never bypasses the durability check', () => {
    expect(CODE).not.toMatch(/allowEphemeral/);
  });

  it('defaults to a path a deploy cannot erase', () => {
    expect(CODE).toMatch(/CANARY_JOURNAL \?\? '\.\/data\/canary-journal\.sqlite'/);
  });
});

describe('the daily spend cap is consulted before anything irreversible', () => {
  it('admits through canarySpend rather than balance alone', () => {
    expect(CODE).toMatch(/admitCanarySpend\(/);
  });

  it('checks admission before the splitter is deployed', () => {
    const admit = CODE.indexOf('admitCanarySpend(');
    const deploy = CODE.indexOf('deploySplitter(');
    expect(admit).toBeGreaterThan(-1);
    expect(admit).toBeLessThan(deploy);
  });

  it('records the fee against the journal once the launch has landed', () => {
    expect(CODE).toMatch(/journal\.recordFee\(/);
  });
});
