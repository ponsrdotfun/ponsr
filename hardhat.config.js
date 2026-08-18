require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// NOTE: contracts are compiled out-of-band via `node compile-all.js` (which uses the pure-JS
// `solc` npm package directly) because this sandbox's network egress does not allow
// binaries.soliditylang.org, which Hardhat's built-in compiler downloader needs. Tests load
// the resulting ABI/bytecode from contracts-test/artifacts.json via ethers.ContractFactory
// directly instead of hre.ethers.getContractFactory(name), so Hardhat's own solc-download
// path is never invoked. Hardhat is still used for its in-process Hardhat Network (funded
// local accounts, EVM semantics) via hardhat-ethers, which does not require solc.
// Forking Robinhood Chain mainnet.
//
// pons has launching switched off and this treasury is not whitelisted, so no real
// launch can be made by anyone -- which would otherwise leave the entire v2 path
// (launchToken, the real factory, the real escrow, FeeSplitterV2 holding real fees)
// untestable until they act. A fork is a private copy of mainnet where the pons
// owner's account can be impersonated: the switch can be flipped locally, the launch
// runs against the ACTUAL deployed contracts, and nothing leaves the machine.
//
// It is not a substitute for a real launch. Impersonation is exactly the thing
// mainnet will not allow, and a fork cannot prove the whitelist arrives or that gas
// behaves. What it does prove is everything downstream of permission: that the
// calldata is accepted, that FeeSplitterV2 is a valid fee recipient, and that fees
// can actually be claimed back out again.
const FORK_URL = process.env.FORK_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

module.exports = {
  solidity: '0.8.24', // present for reference only; not used to compile in this sandbox
  paths: {
    sources: './contracts',
    tests: './contracts-test',
  },
  networks: {
    hardhat: {
      chainId: 4663,
      // Off unless asked for: every other test in this repo runs in-process with no
      // network at all, and silently turning them into forked tests would make a
      // suite that passes offline start depending on someone else's node.
      // blockNumber is pinned deliberately. Without it Hardhat forks at the head and
      // then executes calls AT that block, which it treats as replaying history and
      // refuses to do for a chain whose hardfork timeline it does not ship. Pinning a
      // little behind means every call runs in a block mined on top of the fork, where
      // the configured hardfork applies. It also makes a run reproducible.
      forking:
        process.env.FORK === '1'
          ? {
              url: FORK_URL,
              blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined,
            }
          : undefined,
      // Cancun, not Shanghai. pons v2 graduates into Uniswap V4, whose hooks use
      // transient storage (TSTORE/TLOAD) -- Cancun opcodes. Under Shanghai the launch
      // reverts with a bare "invalid opcode", which says nothing about which one.
      hardfork: 'cancun',
      // Hardhat ships an activation history for the chains it knows and refuses to
      // execute against one it does not, which chain 4663 is. Declaring it from block
      // zero is accurate enough here: every contract involved was deployed long after
      // Cancun, and nothing in the rehearsal replays older history.
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
    },
  },
};
