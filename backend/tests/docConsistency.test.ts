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

describe('the real open item is still named', () => {
  it('the creation-authority finding is documented as OPEN', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs/TURNKEY-CREATION-AUTHORITY.md'), 'utf8');
    expect(text).toMatch(/Status:\s*OPEN/i);
  });

  it('no document claims a leaked bot key cannot reach the treasury', () => {
    for (const rel of DOCS) {
      expect(claims(rel)).not.toMatch(/costs launches, not the treasury/i);
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
