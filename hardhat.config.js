require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// NOTE: contracts are compiled out-of-band via `node compile-all.js` (which uses the pure-JS
// `solc` npm package directly) because this sandbox's network egress does not allow
// binaries.soliditylang.org, which Hardhat's built-in compiler downloader needs. Tests load
// the resulting ABI/bytecode from contracts-test/artifacts.json via ethers.ContractFactory
// directly instead of hre.ethers.getContractFactory(name), so Hardhat's own solc-download
// path is never invoked. Hardhat is still used for its in-process Hardhat Network (funded
// local accounts, EVM semantics) via hardhat-ethers, which does not require solc.
module.exports = {
  solidity: '0.8.24', // present for reference only; not used to compile in this sandbox
  paths: {
    sources: './contracts',
    tests: './contracts-test',
  },
};
