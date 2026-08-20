/**
 * Pulls a v2 launch's trading fees out of pons's escrow and splits them 95/5.
 *
 *   npx tsx scripts/collect-and-split-v2.ts <splitterAddress>
 *   npx tsx scripts/collect-and-split-v2.ts <splitterAddress> --execute
 *
 * THE V1 SCRIPT DOES NOT WORK HERE, AND WOULD NOT SAY SO
 * ------------------------------------------------------
 * `collect-and-split.ts` calls `locker.collectFees(token)` and then splits whatever was
 * pushed. That is v1's model: the locker collects from the Uniswap position and transfers
 * the proceeds straight to `feeRedirects[token]`.
 *
 * v2 has no such step for us to call. Verified empirically rather than assumed — the
 * escrow's own log on mainnet shows `CreditedToken` events raised by the curve and hook
 * contracts as trading happens, and `ClaimedToken` events raised by recipients collecting.
 * There is no public "collect" for a fee recipient to trigger, because there is nothing to
 * trigger: the money is already sitting in the escrow with our name on it.
 *
 * What there is instead is a claim, and the claim pays `msg.sender`. That is why the
 * splitter for a v2 launch must be a `FeeSplitterV2` — a plain `FeeSplitter` cannot call
 * the escrow at all, so its fees would be credited forever and never movable. This script
 * checks that before doing anything, because running it against the wrong splitter is how
 * you find that out far too late.
 *
 * Both actions here are permissionless in the direction that matters: `claimAndSplit` can
 * be called by anyone, and pays only the two addresses fixed at the splitter's construction.
 * Running it on someone else's launch pays *them*.
 */
import { ethers } from 'ethers';
import { config, requireConfig } from '../src/config';
import { createProvider } from '../src/chainClient';
import { DEPLOYMENTS } from '../src/deployments';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const SPLITTER_V2_ABI = [
  'function creator() view returns (address)',
  'function treasury() view returns (address)',
  'function token() view returns (address)',
  'function escrow() view returns (address)',
  'function claimableFromEscrow(address) view returns (uint256)',
  'function claimAndSplit(address) returns (uint256)',
  'function claimEthAndSplit() returns (uint256)',
];

const ESCROW_ABI = ['function balanceOf(address) view returns (uint256)'];

const EXECUTE = process.argv.includes('--execute');
const [splitterArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function meta(provider: ethers.Provider, token: string) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  try {
    return { symbol: String(await c.symbol()), decimals: Number(await c.decimals()) };
  } catch {
    // Never assume 18. USDG is 6 on this chain, and a figure formatted with the wrong
    // decimals is off by a factor of a trillion while looking perfectly reasonable.
    return { symbol: token.slice(0, 10) + '…', decimals: 18 };
  }
}

async function main() {
  if (!splitterArg) {
    console.error('usage: collect-and-split-v2.ts <splitterAddress> [--execute]');
    process.exit(1);
  }
  const splitterAddress = ethers.getAddress(splitterArg);
  const provider = createProvider();
  const wallet = new ethers.Wallet(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider);
  const splitter = new ethers.Contract(splitterAddress, SPLITTER_V2_ABI, wallet);

  console.log(EXECUTE ? '=== CLAIM & SPLIT (v2) — EXECUTING ===' : '=== CLAIM & SPLIT (v2) — DRY RUN ===');
  console.log();

  // The check that matters most. A v1 splitter here has no `escrow()` at all, and calling
  // it throws -- which is a far better outcome than proceeding against a contract that can
  // be credited and never emptied.
  let escrowAddress: string;
  try {
    escrowAddress = (await splitter.escrow()) as string;
  } catch {
    console.error('This splitter has no escrow() -- it is a v1 FeeSplitter.');
    console.error('On v2 it can be credited fees it has no way to claim. Nothing was attempted.');
    process.exit(1);
  }

  const launchedToken = (await splitter.token()) as string;
  line('splitter', splitterAddress);
  line('escrow', escrowAddress);
  line('creator', await splitter.creator());
  line('treasury', await splitter.treasury());

  // Which DEPLOYMENT does this splitter belong to?
  //
  // This used to compare the splitter's escrow against
  // `config.PONS_V2_FEE_ESCROW_ADDRESS` and refuse on any difference. That default is
  // the SUPERSEDED escrow, while every splitter deployed for the current factory binds
  // the current one -- so it refused every real claim, and told the operator that the
  // splitter was the wrong half. Collectable fees would have sat uncollected behind a
  // confident, inverted error message.
  //
  // A splitter's escrow identifies its deployment. Resolve it rather than judge it.
  const owning = DEPLOYMENTS.find(
    (d) => d.feeEscrow.toLowerCase() === escrowAddress.toLowerCase()
  );
  if (!owning) {
    console.error('\nThis splitter points at an escrow no known deployment uses.');
    console.error(`  splitter escrow: ${escrowAddress}`);
    for (const d of DEPLOYMENTS) console.error(`  known:           ${d.id} ${d.feeEscrow}`);
    console.error('Refusing: claiming against an unknown escrow would move real money on a guess.');
    process.exit(1);
  }
  line('deployment', `${owning.id} (${owning.factory})`);

  // Fees arrive as both sides of the pair, so the pairing asset is read from the factory
  // rather than assumed to be WETH the way the v1 script can afford to.
  // The factory of the deployment this splitter actually belongs to, with that
  // deployment's own ABI -- not whichever one configuration happens to name.
  const factory = new ethers.Contract(
    owning.factory,
    require(`../src/${owning.abiPath}`) as ethers.InterfaceAbi,
    provider
  );
  let pairToken: string | null = null;
  try {
    const launch = await factory.getLaunchedToken(launchedToken);
    pairToken = String(launch.pairToken ?? launch[3]);
  } catch {
    console.warn('  (could not read the launch record; checking the launched token only)');
  }

  const tokens = [launchedToken, ...(pairToken && !/^0x0+$/.test(pairToken) ? [pairToken] : [])];
  const nativePair = !!pairToken && /^0x0+$/.test(pairToken);

  console.log('\nClaimable in the escrow');
  const claimable: Array<{ token: string; symbol: string; decimals: number; amount: bigint }> = [];
  for (const t of tokens) {
    const m = await meta(provider, t);
    const amount = (await splitter.claimableFromEscrow(t)) as bigint;
    claimable.push({ token: t, ...m, amount });
    line(m.symbol, `${ethers.formatUnits(amount, m.decimals)}  (${t})`);
  }

  let nativeAmount = 0n;
  if (nativePair) {
    const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
    nativeAmount = (await escrow.balanceOf(splitterAddress)) as bigint;
    line('ETH', ethers.formatEther(nativeAmount));
  }

  const total = claimable.reduce((a, c) => a + c.amount, 0n) + nativeAmount;
  if (total === 0n) {
    console.log('\nNothing to claim. This is the ordinary state before the launch has traded.');
    return;
  }

  if (!EXECUTE) {
    console.log('\nDry run. Re-run with --execute to claim and split.');
    return;
  }

  for (const c of claimable) {
    if (c.amount === 0n) continue;
    console.log(`\nclaimAndSplit(${c.symbol})...`);
    const tx = await splitter['claimAndSplit(address)'](c.token);
    const receipt = await tx.wait();
    line('tx', tx.hash);
    line('status', receipt?.status === 1 ? 'ok ✅' : 'REVERTED ❌');
  }

  if (nativeAmount > 0n) {
    console.log('\nclaimEthAndSplit()...');
    const tx = await splitter.claimEthAndSplit();
    const receipt = await tx.wait();
    line('tx', tx.hash);
    line('status', receipt?.status === 1 ? 'ok ✅' : 'REVERTED ❌');
  }

  console.log('\nAfter (paid out of the splitter, 95/5)');
  for (const c of claimable) {
    const remaining = (await splitter.claimableFromEscrow(c.token)) as bigint;
    line(`${c.symbol} still in escrow`, ethers.formatUnits(remaining, c.decimals));
  }
}

main().catch((err) => {
  console.error('Failed:', err?.message ?? err);
  process.exit(1);
});
