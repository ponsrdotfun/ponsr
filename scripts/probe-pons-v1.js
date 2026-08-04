/**
 * Reads the live pons v1 factory using its REAL verified ABI.
 *
 *   node scripts/probe-pons-v1.js
 *
 * Everything the bot depends on here is owner-settable on pons's side -- the fee, whether
 * launching is enabled at all, and the launch configs that carry the pair token and
 * graduation threshold. This script is how you check the checked-in assumptions still hold
 * without sending a transaction.
 *
 * The ABI comes from `backend/src/abi/ponsLaunchFactory.json`, pulled from
 * https://robinhoodchain.blockscout.com -- that endpoint needs no API key. (The one that
 * does is api.blockscout.com, the Pro aggregator; pointing at it by mistake is why this
 * looked blocked on a signup for weeks.)
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ethers'));

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';

const { abi } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'abi', 'ponsLaunchFactory.json'), 'utf8')
);

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const factory = new ethers.Contract(FACTORY, abi, provider);

  const read = async (label, fn, format) => {
    try {
      const value = await fn();
      console.log(`  ${label.padEnd(22)} ${format ? format(value) : value}`);
      return value;
    } catch (err) {
      console.log(`  ${label.padEnd(22)} <error: ${(err.shortMessage || err.message || '').slice(0, 70)}>`);
      return null;
    }
  };

  console.log(`=== pons v1 factory ${FACTORY} ===`);
  const enabled = await read('launchEnabled()', () => factory.launchEnabled());
  await read('launchFee()', () => factory.launchFee(), (v) => `${ethers.formatEther(v)} ETH`);
  const count = await read('launchConfigCount()', () => factory.launchConfigCount());
  await read('owner()', () => factory.owner());

  if (enabled === false) {
    console.log('\n  ⚠️  Launching is DISABLED. Only whitelisted launchers can call launchToken().');
  }

  if (count !== null) {
    console.log('\n=== launch configs ===');
    for (let id = 0; id < Number(count); id++) {
      try {
        const c = await factory.getLaunchConfig(id);
        console.log(`  [${id}] enabled=${c.enabled}  pairToken=${c.pairToken}`);
        console.log(`       graduationThreshold ${ethers.formatEther(c.graduationThreshold)} (pair-token units)`);
        console.log(`       supply ${c.supply}  maxWallet ${Number(c.maxWalletBps) / 100}%  maxTx ${Number(c.maxTxBps) / 100}%`);
      } catch (err) {
        console.log(`  [${id}] <error: ${(err.shortMessage || err.message || '').slice(0, 60)}>`);
      }
    }
  }

  console.log('\nCompare against backend/src/config.ts (PONS_LAUNCH_CONFIG_ID, PONS_DEX_ID)');
  console.log('and docs/pons-v2-findings.md §9.3, which records what these read on 2026-08-04.');
})();
