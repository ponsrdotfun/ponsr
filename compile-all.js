const solc = require('solc');
const fs = require('fs');
const path = require('path');

function readSource(relPath) {
  return fs.readFileSync(path.join(__dirname, relPath), 'utf8');
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

fs.writeFileSync(
  path.join(__dirname, 'contracts-test', 'artifacts.json'),
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
  path.join(__dirname, 'backend', 'src', 'feeSplitterArtifact.json'),
  // Both splitters, for exactly the same reason. v2 launches need FeeSplitterV2 (the
  // escrow on v2 pays msg.sender, so a splitter that cannot call it strands every fee),
  // and a version emitted from anywhere but this compile is a second copy waiting to
  // go stale.
  JSON.stringify(
    { FeeSplitter: artifacts.FeeSplitter, FeeSplitterV2: artifacts.FeeSplitterV2 },
    null,
    2
  )
);

console.log('✅ Compiled contracts:', Object.keys(artifacts).join(', '));
console.log('   Written to contracts-test/artifacts.json');
console.log('   Written to backend/src/feeSplitterArtifact.json (used by splitterDeployer.ts)');
