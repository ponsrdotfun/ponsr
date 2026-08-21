/**
 * Recompiles the contracts and requires the tracked artifacts to be byte-identical.
 *
 *   node scripts/verify-artifacts-reproducible.js
 *
 * WHY BYTE-IDENTICAL, NOT "THE LOGIC MATCHES"
 * -------------------------------------------
 * An independent review installed the root workspace from `package.json` alone, got
 * solc 0.8.36 against a `^0.8.24` range, and found the logic bytecode matched only after
 * stripping metadata -- the full artifacts differed. "Equal once you remove the parts
 * that differ" is not a check, it is a description.
 *
 * The question that has to stay answerable is: does the artifact the backend deploys
 * correspond to the source in this repository? On 2026-08-04 the answer was no, nobody
 * could tell, and a mainnet launch went out with the old ETH-only splitter as its fee
 * recipient. Those fees are stranded forever.
 *
 * So: compile, compare every byte, restore whatever was there before, and exit non-zero
 * on any difference. Run in CI and before any deploy.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACKED = [
  'contracts-test/artifacts.json',
  'backend/src/feeSplitterArtifact.json',
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p));

const before = new Map(TRACKED.map((p) => [p, read(p)]));

console.log('=== ARTIFACT REPRODUCIBILITY ===');
console.log('  solc pinned      ', require('../package.json').dependencies.solc);
console.log('  solc installed   ', require('solc/package.json').version);
console.log('');

execFileSync('node', [path.join(__dirname, '..', 'compile-all.js')], { stdio: 'pipe' });

let differs = false;
for (const p of TRACKED) {
  const now = read(p);
  const same = Buffer.compare(before.get(p), now) === 0;
  console.log(`  ${same ? 'identical' : 'DIFFERS  '}  ${p}`);
  if (!same) {
    differs = true;
    console.log(`      tracked   ${sha(before.get(p)).slice(0, 32)}…  ${before.get(p).length} bytes`);
    console.log(`      rebuilt   ${sha(now).slice(0, 32)}…  ${now.length} bytes`);
    // Restore, so a failing check does not itself change the tree it is judging.
    fs.writeFileSync(path.join(__dirname, '..', p), before.get(p));
  }
}

console.log('');
if (differs) {
  console.log('=== NOT REPRODUCIBLE ===');
  console.log('  The tracked artifacts are not what this source and this compiler produce.');
  console.log('  Either the artifacts are stale, or the toolchain moved. Both matter: the');
  console.log('  backend deploys from the tracked copy, and on 2026-08-04 a stale one');
  console.log('  stranded a creator\'s fees permanently.');
  console.log('  Files were restored; nothing in the working tree was changed by this check.');
  process.exit(1);
}
console.log('=== REPRODUCIBLE ===');
console.log('  Every tracked artifact is byte-for-byte what this source compiles to.');
