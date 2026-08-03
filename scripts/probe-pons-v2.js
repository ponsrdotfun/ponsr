/* Ask the deployed pons v2 factory directly. Docs can lag; the chain cannot. */
const { ethers } = require('ethers');

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8';

const ABI = [
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  'function approvedPairTokens(address) view returns (bool)',
  'function pairTokenEconomics(address) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  'function whitelistedLaunchers(address) view returns (bool)',
];

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, 4663);
  const f = new ethers.Contract(FACTORY, ABI, provider);

  const out = async (label, fn) => {
    try {
      const v = await fn();
      console.log(`  ${label.padEnd(26)} ${v}`);
      return v;
    } catch (e) {
      console.log(`  ${label.padEnd(26)} <not callable: ${(e.shortMessage || e.message || '').slice(0, 60)}>`);
      return null;
    }
  };

  console.log('=== v2 factory state (live) ===');
  const fee = await out('launchFee()', () => f.launchFee());
  if (fee !== null) console.log(`  ${''.padEnd(26)} = ${ethers.formatEther(fee)} ETH`);
  await out('launchEnabled()', () => f.launchEnabled());
  const maxTax = await out('maxCreatorTaxBps()', () => f.maxCreatorTaxBps());
  if (maxTax !== null) console.log(`  ${''.padEnd(26)} = ${Number(maxTax) / 100}% max creator tax`);
  await out('launchConfigCount()', () => f.launchConfigCount());

  // Native ETH pair is the zero address per the docs.
  console.log('\n=== pair tokens ===');
  await out('approved(0x0 = native ETH)', () => f.approvedPairTokens(ethers.ZeroAddress));

  // WETH from the v1 docs, as a sanity check on a known real token.
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  await out('approved(WETH)', () => f.approvedPairTokens(WETH));
  try {
    const e = await f.pairTokenEconomics(WETH);
    console.log(`  WETH economics             phantomQuote=${e[0]} graduation=${e[1]} decimals=${e[2]}`);
  } catch (e) {
    console.log('  WETH economics             <none>');
  }
})();
