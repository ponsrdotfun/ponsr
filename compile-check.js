const solc = require('solc');
const fs = require('fs');
const path = require('path');

const contractPath = path.join(__dirname, 'contracts', 'FeeSplitter.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'FeeSplitter.sol': { content: source },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
    optimizer: { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === 'error') {
      hasError = true;
      console.log('ERROR:', err.formattedMessage);
    } else {
      console.log('WARNING:', err.formattedMessage);
    }
  }
}

if (hasError) {
  console.log('\n❌ COMPILATION FAILED');
  process.exit(1);
}

const contract = output.contracts['FeeSplitter.sol']['FeeSplitter'];
const bytecodeSize = contract.evm.bytecode.object.length / 2;
const deployedSize = contract.evm.deployedBytecode.object.length / 2;

console.log('\n✅ COMPILATION SUCCEEDED');
console.log(`   ABI entries: ${contract.abi.length}`);
console.log(`   Init bytecode size: ${bytecodeSize} bytes`);
console.log(`   Deployed (runtime) bytecode size: ${deployedSize} bytes (limit: 24576 bytes)`);
console.log(`   Under size limit: ${deployedSize <= 24576 ? 'YES' : 'NO -- EXCEEDS EIP-170 LIMIT'}`);

// Save ABI for backend + docs use
fs.writeFileSync(
  path.join(__dirname, 'contracts', 'FeeSplitter.abi.json'),
  JSON.stringify(contract.abi, null, 2)
);
console.log('\n   ABI written to contracts/FeeSplitter.abi.json');
