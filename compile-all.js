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
    'test-helpers/Malicious.sol': { content: readSource('contracts/test-helpers/Malicious.sol') },
  },
  settings: {
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object'] },
    },
    optimizer: { enabled: true, runs: 200 },
  },
};

function findImports(importPath) {
  // Resolve "../FeeSplitter.sol" from test-helpers/Malicious.sol
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

console.log('✅ Compiled contracts:', Object.keys(artifacts).join(', '));
console.log('   Written to contracts-test/artifacts.json');
