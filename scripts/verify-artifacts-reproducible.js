/**
 * Rebuilds the contracts and requires the COMMITTED artifacts to be byte-identical.
 *
 *   node scripts/verify-artifacts-reproducible.js
 *
 * WHY THE BASELINE IS GIT, NOT THE WORKING TREE
 * ---------------------------------------------
 * The first version read the tracked files, ran `compile-all.js` in place, and compared
 * the result against what it had just read. That is a check that passes whenever the
 * compile ran first -- demonstrated: tamper with the artifact, run `npm run compile`,
 * and this reported REPRODUCIBLE about a file nobody had verified.
 *
 * A verifier whose baseline is mutable is not a verifier. The baseline is now
 * `git show HEAD:<path>` -- immutable bytes nothing in this process can rewrite -- and
 * the rebuild goes to a temporary directory, so the working tree is never touched at
 * all, on pass or on failure.
 *
 * WHY THE BUILD IS PLATFORM-NEUTRAL NOW
 * -------------------------------------
 * Solidity hashes the source into the contract's metadata, and appends that metadata to
 * the deployed bytecode. The `.sol` files sit in a Windows checkout with CRLF and a
 * Linux checkout with LF, so passing them through verbatim produced artifacts whose
 * logic matched and whose metadata tail did not -- an independent Linux rebuild with the
 * same pinned solc found exactly that.
 *
 * `compile-all.js` normalises line endings and strips a BOM before compiling, so the
 * compiler input is byte-identical wherever it runs. `.gitattributes` pins `*.sol` to LF
 * as well, but the normalisation is what actually guarantees it: a checkout can be made
 * by something that does not read `.gitattributes`.
 *
 * ON METADATA: the creation bytecode INCLUDES the CBOR metadata tail. It is not stripped
 * here and must not be -- it is part of what gets deployed, and comparing "everything
 * except the part that differs" is a description rather than a check.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TRACKED = ['contracts-test/artifacts.json', 'backend/src/feeSplitterArtifact.json'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Committed bytes, straight from the object database. */
function committed(relPath) {
  return execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

/** Whether git considers the tree dirty, so a clean run can prove it stayed clean. */
function dirtyFiles() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

console.log('=== ARTIFACT REPRODUCIBILITY ===');
console.log('  solc pinned      ', require('../package.json').dependencies.solc);
console.log('  solc installed   ', require('solc/package.json').version);
console.log('  platform         ', `${os.platform()} ${os.arch()}`);
console.log('  baseline         ', 'git show HEAD:<artifact>  (immutable)');

const dirtyBefore = dirtyFiles();

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-artifacts-'));
try {
  execFileSync('node', [path.join(ROOT, 'compile-all.js')], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, ARTIFACT_OUT_DIR: out },
  });

  console.log('');
  let differs = false;
  for (const rel of TRACKED) {
    const rebuilt = fs.readFileSync(path.join(out, path.basename(rel)));
    const base = committed(rel);
    const same = Buffer.compare(base, rebuilt) === 0;
    console.log(`  ${same ? 'identical' : 'DIFFERS  '}  ${rel}`);
    if (!same) {
      differs = true;
      console.log(`      committed  ${sha(base).slice(0, 32)}…  ${base.length} bytes`);
      console.log(`      rebuilt    ${sha(rebuilt).slice(0, 32)}…  ${rebuilt.length} bytes`);
    }
  }

  // The tree must be exactly as it was found, whichever way this goes. A verifier that
  // edits what it inspects can only be run once meaningfully.
  const dirtyAfter = dirtyFiles();
  const unchanged =
    dirtyBefore.length === dirtyAfter.length && dirtyBefore.every((f, i) => f === dirtyAfter[i]);
  console.log('');
  console.log(`  working tree     ${unchanged ? 'unchanged by this check' : 'CHANGED BY THIS CHECK'}`);
  if (!unchanged) {
    console.log('    before:', JSON.stringify(dirtyBefore));
    console.log('    after :', JSON.stringify(dirtyAfter));
    differs = true;
  }

  /**
   * A SECOND, separate question: is the file on disk the committed one?
   *
   * Everything above compares the rebuild against git. That proves the COMMITTED
   * artifacts reproduce -- and says nothing about the bytes actually sitting in
   * `backend/src/`, which is what the running backend imports. A dirty working tree can
   * hold a modified artifact while the committed one reproduces perfectly.
   *
   * Reported separately rather than folded in, because the two failures mean different
   * things: a committed mismatch is stale artifacts or a moved toolchain, a working-tree
   * mismatch is uncommitted local edits.
   */
  console.log('');
  let treeDiffers = false;
  for (const rel of TRACKED) {
    const onDisk = fs.readFileSync(path.join(ROOT, rel));
    const base = committed(rel);
    const same = Buffer.compare(base, onDisk) === 0;
    console.log(`  ${same ? 'committed' : 'MODIFIED '}  ${rel}  (working tree vs HEAD)`);
    if (!same) treeDiffers = true;
  }

  console.log('');
  if (treeDiffers && !differs) {
    console.log('=== COMMITTED ARTIFACTS REPRODUCE, WORKING TREE IS MODIFIED ===');
    console.log('  The rebuild matches what is committed, so the source and toolchain agree.');
    console.log('  But a file on disk differs from HEAD, and the backend imports the file on');
    console.log('  disk -- not the commit. Commit it or restore it before deploying.');
    process.exit(1);
  }

  if (differs) {
    console.log('=== NOT REPRODUCIBLE ===');
    console.log('  The committed artifacts are not what this source and this compiler produce.');
    console.log('  Either they are stale, or the toolchain moved. Both matter: the backend');
    console.log('  deploys from the committed copy, and on 2026-08-04 a stale one stranded a');
    console.log("  creator's fees permanently.");
    process.exit(1);
  }
  console.log('=== REPRODUCIBLE ===');
  console.log('  Every committed artifact is byte-for-byte what this source compiles to,');
  console.log('  compared against git rather than against a file this process wrote,');
  console.log('  and the working-tree copies match HEAD.');
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
