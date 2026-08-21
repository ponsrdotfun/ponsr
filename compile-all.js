const solc = require('solc');

/**
 * The compiler that produced whatever this run writes.
 *
 * `solc` was a caret range, and an independent reviewer installing from package.json
 * alone got 0.8.36 against `^0.8.24`. The logic bytecode matched after stripping
 * metadata; the full artifacts did not. That makes "does this committed artifact
 * correspond to this source?" unanswerable -- which is precisely the question the
 * 2026-08-04 incident turned on, when a stale hand-kept copy deployed the old ETH-only
 * splitter and stranded its fees forever.
 *
 * Pinned exactly in package.json, and stamped into the artifact so a mismatch is visible
 * by reading the file rather than by rebuilding and diffing.
 */
const SOLC_VERSION = require('solc/package.json').version;
const fs = require('fs');
const path = require('path');

/**
 * Source as the compiler must see it, identically on every platform.
 *
 * Solidity hashes the source into the contract's metadata, and the metadata is appended
 * to the deployed bytecode. So line endings are not cosmetic here: these files sit in a
 * Windows checkout with CRLF and in a Linux checkout with LF, and passing them through
 * verbatim produced artifacts whose logic matched but whose metadata tail did not.
 *
 * An independent Linux rebuild with the exact same pinned solc found precisely that, and
 * it makes the only question that matters -- does this committed artifact correspond to
 * this source? -- unanswerable depending on who is asking.
 *
 * Normalised to LF, so the compiler input is byte-identical wherever it runs. A leading
 * BOM goes too: it is invisible, it is a source byte, and it would do the same thing.
 */
function readSource(relPath) {
  return fs
    .readFileSync(path.join(__dirname, relPath), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

const input = {
  language: 'Solidity',
  sources: {
    'FeeSplitter.sol': { content: readSource('contracts/FeeSplitter.sol') },
    'FeeSplitterV2.sol': { content: readSource('contracts/FeeSplitterV2.sol') },
    'test-helpers/Malicious.sol': { content: readSource('contracts/test-helpers/Malicious.sol') },
    'test-helpers/MockERC20.sol': { content: readSource('contracts/test-helpers/MockERC20.sol') },
    'test-helpers/MockEscrow.sol': { content: readSource('contracts/test-helpers/MockEscrow.sol') },
  },
  settings: {
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object'] },
    },
    optimizer: { enabled: true, runs: 200 },
  },
};

function findImports(importPath) {
  // Two shapes reach here: "../FeeSplitter.sol" from test-helpers/Malicious.sol, and
  // "./FeeSplitter.sol" from FeeSplitterV2.sol. Try the plain path first so a
  // top-level import does not have to pretend it lives in test-helpers.
  const direct = path.normalize(importPath.replace(/^\.\//, ''));
  try {
    return { contents: readSource(path.join('contracts', direct)) };
  } catch (e) { /* fall through */ }
  const resolved = path.normalize(path.join('test-helpers', importPath));
  try {
    return { contents: readSource(path.join('contracts', resolved)) };
  } catch (e) {
    return { error: 'File not found: ' + importPath };
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === 'error') {
      hasError = true;
      console.log('ERROR:', err.formattedMessage);
    }
  }
}
if (hasError) {
  console.log('\n❌ COMPILATION FAILED');
  process.exit(1);
}

const artifacts = {};
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    artifacts[name] = {
      abi: contract.abi,
      bytecode: '0x' + contract.evm.bytecode.object,
    };
  }
}

/**
 * Where to write.
 *
 * Defaults to the tracked locations. A verifier sets ARTIFACT_OUT_DIR so it can rebuild
 * and compare WITHOUT overwriting the files it is judging -- the previous verifier
 * compiled in place and then compared against the result, which meant a tampered
 * artifact passed as long as the compile ran first.
 */
const OUT_DIR = process.env.ARTIFACT_OUT_DIR || null;
const outPath = (...parts) =>
  OUT_DIR ? path.join(OUT_DIR, parts[parts.length - 1]) : path.join(__dirname, ...parts);
if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

fs.writeFileSync(
  outPath('contracts-test', 'artifacts.json'),
  JSON.stringify(artifacts, null, 2)
);

// The backend deploys the splitter from its own copy of the artifact. That copy used to be
// maintained by hand, and on 2026-08-04 that cost real money: FeeSplitter was rewritten for
// ERC20 and recompiled, the tests all passed against the fresh artifact above, and the deploy
// path kept using the stale hand-copied one. A mainnet launch went out with the old ETH-only
// contract as its fee recipient, and the ERC20 fees it received are stranded in it forever.
//
// So this is written here, from the same compile, every time. Two copies of one artifact only
// stay in step if nobody has to remember to make them.
fs.writeFileSync(
  outPath('backend', 'src', 'feeSplitterArtifact.json'),
  // Both splitters, for exactly the same reason. v2 launches need FeeSplitterV2 (the
  // escrow on v2 pays msg.sender, so a splitter that cannot call it strands every fee),
  // and a version emitted from anywhere but this compile is a second copy waiting to
  // go stale.
  JSON.stringify(
    {
      // Stamped so a mismatch is visible by reading the file. Without it the artifact
      // said only { abi, bytecode } -- nothing recorded what produced it, so two
      // machines could each hold a different, internally consistent copy and neither
      // could tell.
      _compiler: { solc: SOLC_VERSION, optimizer: input.settings.optimizer },
      FeeSplitter: artifacts.FeeSplitter,
      FeeSplitterV2: artifacts.FeeSplitterV2,
    },
    null,
    2
  )
);

console.log('✅ Compiled contracts:', Object.keys(artifacts).join(', '));
console.log('   solc', SOLC_VERSION, '(pinned exactly in package.json)');
console.log('   Written to contracts-test/artifacts.json');
console.log('   Written to backend/src/feeSplitterArtifact.json (used by splitterDeployer.ts)');
