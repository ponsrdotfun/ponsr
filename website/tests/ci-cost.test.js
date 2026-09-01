/**
 * CI MUST NOT PAY TWICE FOR THE SAME COMMIT.
 *
 * The repository's Actions minutes ran out mid-day, and the arithmetic explains
 * why. `verify.yml` fired on BOTH `push` and `pull_request`, so every push to a
 * PR branch ran the whole matrix twice over the same commit. And its second job
 * runs on `windows-latest`, which GitHub bills at TWICE the Linux rate, on every
 * push -- including website-only changes that cannot reach the code it tests.
 *
 * A website PR therefore cost 2 Linux runs plus 2 Windows runs: about six
 * Linux-equivalents to prove one commit. It is one now.
 *
 * These pin the two decisions, because a misconfigured trigger does not fail --
 * it just quietly spends, and the first symptom is a workflow that cannot start.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a branch push and its pull request do not both run the matrix', () => {
  const verify = read('.github/workflows/verify.yml');
  // `pull_request` already covers a branch push once a PR is open. `main` stays
  // on push because a merge commit is not a pull request.
  assert.match(verify, /push:\s*\n\s*branches: \[main\]/);
  assert.match(verify, /^on:\s*\n\s*pull_request:/m);
});

test('the Windows job is skipped when nothing it tests has changed', () => {
  const windows = read('.github/workflows/verify-windows.yml');

  // A job cannot carry its own `paths` filter, but a workflow can -- which is
  // the whole reason this is a separate file.
  assert.match(windows, /paths:/);
  assert.match(windows, /'backend\/\*\*'/);
  // The workflow must re-run when its own definition changes, or a broken
  // filter can never be corrected by the run that corrects it.
  assert.match(windows, /'\.github\/workflows\/verify-windows\.yml'/);

  // Same job, same name: anything referring to it still finds it.
  assert.match(windows, /^\s{2}verify-windows-acl:/m);
  assert.match(windows, /runs-on: windows-latest/);
  assert.match(windows, /journal custody tests \(Windows\)/);

  // And it must not have been left behind in the Linux workflow too.
  assert.doesNotMatch(read('.github/workflows/verify.yml'), /windows-latest/);
});

test('the Linux workflow still runs every check it always ran', () => {
  const verify = read('.github/workflows/verify.yml');
  for (const step of [
    'backend typecheck',
    'backend build',
    'backend tests',
    'contract tests',
    'website smoke tests',
    'website tests',
    'artifact reproducibility (run 1)',
    'artifact reproducibility (run 2)',
    'git diff --check',
    'backend npm audit (production deps)',
  ]) {
    assert.ok(verify.includes(step), `${step} was lost in the split`);
  }
});
