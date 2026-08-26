import * as fs from 'fs';
import * as path from 'path';

/**
 * Claims in documents that go stale silently.
 *
 * Two kinds have drifted repeatedly here, and both look like evidence while being wrong:
 *
 *   COUNTS      "151/151 passing", "Total: 232", "74/74 checks". Every one was true the
 *               day it was typed and wrong within a week. A reader cannot tell a current
 *               figure from a fossil, so the figure is worse than nothing.
 *
 *   BLOCKERS    "the only remaining blocker". True of the SUPERSEDED factory, untrue
 *               since 2026-08-03 -- and it survived three closure passes, twice by being
 *               "corrected" with a preface while the body kept asserting it.
 *
 * Fixing a document is easy. Keeping it fixed is what this file is for.
 *
 * HISTORY IS NOT A CLAIM
 * ----------------------
 * A line recording what a run once scored, or quoting a sentence that was wrong, must
 * survive: deleting it removes the reason a guard exists while leaving the guard. So
 * documents mark those passages explicitly:
 *
 *     <!-- historical -->  ...  <!-- /historical -->
 *
 * An explicit marker rather than a pattern guess. The first version of this file tried to
 * recognise corrections by phrases like "an earlier version", and a correction that
 * spanned two lines defeated it -- the quote on the second line read as a live claim.
 */

const ROOT = path.join(__dirname, '../..');
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'generated',
  'dist',
  'build',
  'coverage',
  'historical',
  'archive',
  'archives',
]);

function markdownFiles(dir = ROOT): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name.toLowerCase())) return [];
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.md')
      ? [path.relative(ROOT, absolute).replace(/\\/g, '/')]
      : [];
  });
}

const DOCS = markdownFiles();

/** The document's live claims, with explicitly marked history removed. */
function claims(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return raw.replace(/<!--\s*historical\s*-->[\s\S]*?<!--\s*\/historical\s*-->/g, '');
}

describe('documents state no hardcoded test counts', () => {
  it('scans markdown recursively rather than a hand-maintained shortlist', () => {
    expect(DOCS).toContain('docs/MASTER-twitter-launch-bot.md');
    expect(DOCS).toContain('backend/docs/SETUP.md');
  });

  for (const rel of DOCS) {
    it(`${rel} claims no current pass count`, () => {
      // Only figures presented as the state of a suite. A ratio like 950/50 is not a
      // count, and a dated record inside a historical block is not a claim.
      const matches =
        claims(rel).match(
          /\b\d{2,4}\s*\/\s*\d{2,4}\b(?=[^\n]{0,40}\b(passing|checks|tests|suites?)\b)/gi
        ) ?? [];
      expect(matches).toEqual([]);
    });

    it(`${rel} claims no fixed total`, () => {
      const text = claims(rel);
      expect(text).not.toMatch(/Total:\s*\d+\s+(automated|tests|checks)/i);
      expect(text).not.toMatch(/\b\d{2,4}\s+(tests|checks)\s+passing\b/i);
    });
  }
});

describe('no document calls the whitelist a blocker', () => {
  /**
   * `canLaunch(treasury)` is true through the public gate, so a whitelist is continuity
   * insurance against that gate closing -- not permission to launch. Calling it a blocker
   * sends the owner to wait on somebody else's reply instead of closing the real open
   * item, which is the Turnkey creation authority.
   */
  for (const rel of DOCS) {
    it(`${rel} does not name a whitelist as the blocker`, () => {
      const text = claims(rel);
      expect(text).not.toMatch(/only remaining blocker/i);
      expect(text).not.toMatch(/single thing standing between/i);
      expect(text).not.toMatch(/only thing (left|blocking|standing)/i);
    });
  }
});

describe('the migration cannot silently enable public launching', () => {
  const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('defaults the independent Ponsr gate off with exact string parsing', () => {
    const text = source('backend/src/config.ts');
    expect(text).toMatch(/PUBLIC_LAUNCH_ENABLED:[\s\S]{0,160}enum\(\['true', 'false'\]\)[\s\S]{0,160}default\('false'\)/);
    expect(text).not.toMatch(/PUBLIC_LAUNCH_ENABLED:\s*z\.coerce\.boolean/);
  });

  it('checks the pause before the paid parser in the mention path', () => {
    const text = source('backend/src/orchestrator.ts');
    expect(text.indexOf("reason: 'PUBLIC_LAUNCH_PAUSED'")).toBeGreaterThan(-1);
    expect(text.indexOf("reason: 'PUBLIC_LAUNCH_PAUSED'")).toBeLessThan(text.indexOf('deps.parser.parse'));
  });

  it('records the actual production sequence instead of a stale v1-first rollout', () => {
    const text = claims('docs/ROLLOUT-RUNBOOK.md');
    expect(text).toMatch(/runs `pons-v2-current-7ed`/);
    expect(text).toMatch(/fly secrets set PUBLIC_LAUNCH_ENABLED=false/);
    // The lever the old sequence flipped no longer exists. A runbook step naming it would
    // send an operator to set a variable nothing reads, and then to trust the result.
    expect(text).not.toMatch(/fly secrets set PONS_FACTORY_VERSION/);
    expect(text).not.toMatch(/Deploy the new code with `PONS_FACTORY_VERSION` \*\*still `v1`/);
  });
});

describe('the creation-authority finding is recorded as closed, and honestly', () => {
  const FINDING = path.join(ROOT, 'docs/TURNKEY-CREATION-AUTHORITY.md');

  /**
   * This guard used to require `Status: OPEN`.
   *
   * That was right while the finding was live: it stopped the most dangerous item in the
   * repository being quietly dropped. But a guard that pins a status is only ever correct
   * until the status changes, and on 2026-08-22 the finding was closed — at which point
   * the guard began enforcing a statement that was no longer true, and CI went green
   * doing it. A test that keeps a document honest can become the reason it is wrong.
   *
   * So it now pins CLOSED, and the three assertions below make the closure hard to
   * misrepresent in either direction: it cannot silently revert to OPEN, it must carry
   * the evidence that closed it, and it must not be inflated into protection it does not
   * provide.
   */
  it('is marked CLOSED with a date', () => {
    expect(claims('docs/TURNKEY-CREATION-AUTHORITY.md')).toMatch(/Status:\s*CLOSED\s*[—-]\s*\d{4}-\d{2}-\d{2}/i);
  });

  it('does not silently return to OPEN', () => {
    // Historical blocks are stripped, so the record of the OPEN period survives while a
    // live OPEN claim fails. Reopening is a deliberate edit to this test, not a slip.
    expect(claims('docs/TURNKEY-CREATION-AUTHORITY.md')).not.toMatch(/Status:\s*OPEN/i);
  });

  it('names the policy that closed it and the one that was removed', () => {
    const text = claims('docs/TURNKEY-CREATION-AUTHORITY.md');
    expect(text).toMatch(/b647cc07-a7fe-4941-914c-2c1032392f80/);
    expect(text).toMatch(/897d432e-16f4-4a5e-b16e-42c365508ec6/);
  });

  it('keeps the OPEN period as historical evidence rather than deleting it', () => {
    // The guards elsewhere in this repository only make sense if the finding was once
    // live. Erasing that leaves them looking arbitrary, and the next person removes them.
    const raw = fs.readFileSync(FINDING, 'utf8');
    expect(raw).toMatch(/<!--\s*historical\s*-->/);
    expect(raw).toMatch(/Status:\s*OPEN/i);
  });

  /**
   * The residual is the part most likely to be overstated next.
   *
   * Option A binds `eth.tx.value`, not initcode. A zero-value deploy of arbitrary code is
   * still possible — it costs gas and cannot carry treasury value. Describing that as
   * initcode being bound, restricted or protected would claim a control nobody built.
   */
  it('records the residual in the terms that are actually true', () => {
    const text = claims('docs/TURNKEY-CREATION-AUTHORITY.md');
    expect(text).toMatch(/initcode is not bound|initcode is still unbound/i);
    expect(text).toMatch(/zero-value/i);
    expect(text).toMatch(/gas,? (not|never) treasury/i);
  });

  /**
   * Phrasings that can only be claims, never prohibitions.
   *
   * The first version of this guard forbade "initcode is bound" across every document and
   * failed immediately — on the sentence in the finding itself that forbids saying it. A
   * regex cannot tell a rule from its own statement, so matching the bare phrase catches
   * the warning as readily as the lie.
   *
   * These patterns are narrower and, being narrower, are not airtight: a sufficiently
   * inventive overstatement will slip past. The positive assertions above are the real
   * guarantee; this is a catch for the specific sentences somebody would reach for first.
   */
  it('never inflates the residual into a control that was not built', () => {
    for (const rel of DOCS) {
      const t = claims(rel);
      expect(t).not.toMatch(/initcode (binding|is bound) is (enforced|in place|active)/i);
      expect(t).not.toMatch(/all contract creations? (is|are) denied/i);
      expect(t).not.toMatch(/creation is (fully|now) (bound|constrained|locked)/i);
    }
  });

  /**
   * Closing the finding says nothing about the rollout.
   *
   * Asserted positively on the one document that must carry the caveat, rather than by
   * forbidding a string across every document: `TURNKEY_POLICY_CONFIRMED=true` appears
   * legitimately in docs/DEPLOY.md as part of a command template and in two files quoting
   * the verifier's own output. Forbidding the string flagged all three.
   */
  it('states plainly what the closure did not do', () => {
    const text = claims('docs/TURNKEY-CREATION-AUTHORITY.md');
    expect(text).toMatch(/TURNKEY_POLICY_CONFIRMED[^.]{0,60}\bnot\b/i);
    expect(text).toMatch(/no canary has been run/i);
    expect(text).toMatch(/has \*\*not\*\* been flipped|not been flipped/i);
  });

  it('no document claims a canary has completed', () => {
    for (const rel of DOCS) {
      expect(claims(rel)).not.toMatch(/canary (has )?(completed|succeeded|passed)/i);
    }
  });

  it('no document claims a leaked bot key cannot reach the treasury', () => {
    /**
     * Matched on meaning, not on the one sentence that was fixed first.
     *
     * The original pattern was the literal `costs launches, not the treasury`. BUILD-STATUS.md
     * said the same false thing four words differently -- "cost launches rather than the
     * treasury" -- and sailed straight through, in the document whose whole job is to say what
     * is actually true. A guard written around a single phrasing only proves that phrasing is
     * gone.
     *
     * The claim is false because the policy allows a contract creation with no value
     * constraint, and Turnkey was measured signing one carrying 1 ETH.
     */
    const COST_LAUNCHES_NOT_TREASURY = /costs?\s+launches\b[^.]{0,40}\bthe treasury/i;
    const TREASURY_UNREACHABLE =
      /(treasury|hot wallet)[^.]{0,60}\bcannot be (moved|reached|touched|spent|drained)/i;
    const ONE_WAY_VALVE = /hot wallet is a one-way valve/i;

    for (const rel of DOCS) {
      const text = claims(rel);
      expect(text).not.toMatch(COST_LAUNCHES_NOT_TREASURY);
      expect(text).not.toMatch(TREASURY_UNREACHABLE);
      expect(text).not.toMatch(ONE_WAY_VALVE);
    }
  });

  it('the authority matrix names the deny-all probe', () => {
    // The most dangerous script in the repository must be listed where an operator
    // looks, not only in a test file.
    const text = fs.readFileSync(path.join(ROOT, 'docs/TURNKEY-CREATION-AUTHORITY.md'), 'utf8');
    expect(text).toMatch(/turnkey-policy-probe/);
    expect(text).toMatch(/DENY-ALL|deny-everything/i);
  });
});
