/**
 * Pulls a v2 launch's trading fees out of pons's escrow and splits them 95/5.
 *
 *   npm run collect:v2 -- <splitterAddress> --token=0x...              # dry run, keyless
 *   COLLECTOR_OPERATOR_PRIVATE_KEY=0x... \
 *     npm run collect:v2 -- <splitterAddress> --token=0x... --execute
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
import { config } from '../src/config';
import { createProvider } from '../src/chainClient';
import { DEPLOYMENTS } from '../src/deployments';
import { assertDeploymentIdentity } from '../src/deploymentIdentity';
import { resolveLaunchedToken, assertLaunchLineage, reconcileClaim } from '../src/splitterLineage';
import { Db } from '../src/db';

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
  // The queued ledger. FeeSplitter records a share it cannot deliver here rather
  // than reverting the whole split, so without reading it a legitimately queued
  // payout looks exactly like money that failed to arrive.
  'function claimableERC20(address,address) view returns (uint256)',
  'function claimable(address) view returns (uint256)',
  'function claimAndSplit(address) returns (uint256)',
  'function claimEthAndSplit() returns (uint256)',
];

const ESCROW_ABI = ['function balanceOf(address) view returns (uint256)'];

const EXECUTE = process.argv.includes('--execute');
const [splitterArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/** The launched token, for an operator claiming away from the bot's launch records. */
const tokenArg = process.argv.find((a) => a.startsWith('--token='))?.slice('--token='.length);

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

  /**
   * Reads need no key, and asking for one is worse than pointless.
   *
   * This built a Wallet from `TREASURY_SIGNER_PRIVATE_KEY` on the first line of main(),
   * before knowing whether `--execute` had even been passed. So a dry run -- whose whole
   * purpose is to look without touching -- could not run without a production signing
   * credential sitting on the machine.
   *
   * Backwards twice: it made the safe path require the dangerous input, and it taught an
   * operator to put a raw key somewhere in order to READ something. The key it named is
   * also the one production must never set, since `RawKeyTreasurySigner` refuses to run
   * under NODE_ENV=production at all.
   *
   * A claim is permissionless on chain and pays only the two addresses fixed at the
   * splitter's construction, so signing it is an ordinary transaction from any funded
   * wallet the operator controls -- never the bot's.
   */
  const splitter = new ethers.Contract(splitterAddress, SPLITTER_V2_ABI, provider);

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

  // `splitter.token()` is a placeholder, not a record.
  //
  // The bot deploys the splitter BEFORE the launch that creates the token, so this field
  // is ZeroAddress on every splitter it has ever produced. Reading it and calling the
  // result "the launched token" is why this script could not recover fees from a single
  // bot launch -- and that failure surfaces the day a creator asks where their money is.
  const splitterTokenField = (await splitter.token()) as string;
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
  //
  // EXACTLY one match, and the deployment's full identity verified before any claim.
  // Two deployments sharing an escrow would make "which factory launched this token"
  // ambiguous, and the answer decides which contract is asked about the pairing asset.
  const matches = DEPLOYMENTS.filter(
    (d) => d.feeEscrow.toLowerCase() === escrowAddress.toLowerCase()
  );
  if (matches.length > 1) {
    console.error('\nMore than one known deployment uses this escrow:');
    for (const d of matches) console.error(`  ${d.id} ${d.factory}`);
    console.error('Refusing: which factory launched this token decides what is claimed.');
    process.exit(1);
  }
  const owning = matches[0];
  if (!owning) {
    console.error('\nThis splitter points at an escrow no known deployment uses.');
    console.error(`  splitter escrow: ${escrowAddress}`);
    for (const d of DEPLOYMENTS) console.error(`  known:           ${d.id} ${d.feeEscrow}`);
    console.error('Refusing: claiming against an unknown escrow would move real money on a guess.');
    process.exit(1);
  }
  line('deployment', `${owning.id} (${owning.factory})`);

  // The same identity check the launch path runs, before money moves in the other
  // direction. A claim is a transfer, and claiming against a factory that is not the one
  // the registry describes is the same mistake as launching through one.
  await assertDeploymentIdentity(owning, provider);
  line('identity', 'chain id, runtime hash, ABI hash, selector and escrow all match');

  // Fees arrive as both sides of the pair, so the pairing asset is read from the factory
  // rather than assumed to be WETH the way the v1 script can afford to.
  // The factory of the deployment this splitter actually belongs to, with that
  // deployment's own ABI -- not whichever one configuration happens to name.
  const factory = new ethers.Contract(
    owning.factory,
    require(`../src/${owning.abiPath}`) as ethers.InterfaceAbi,
    provider
  );
  // Which token, from somewhere durable.
  const fromDb = (() => {
    try {
      const db = new Db(config.DATABASE_PATH);
      try {
        return db.getLaunchBySplitter(splitterAddress);
      } finally {
        db.close();
      }
    } catch {
      // Running away from the bot's database is normal for an operator claiming by hand.
      // It only means the token has to be stated explicitly.
      return null;
    }
  })();

  const resolved = resolveLaunchedToken({
    splitterTokenField,
    explicitToken: tokenArg,
    provenanceToken: fromDb?.tokenAddress ?? null,
  });
  const launchedToken = resolved.token;
  line('launched token', `${launchedToken}  (from ${resolved.source})`);

  // FAIL CLOSED from here.
  //
  // Every read below decides where money goes. The previous version caught a failed
  // `getLaunchedToken` and continued with a warning, so an RPC blip, an ABI mismatch and
  // an unknown token all ended the same way: a claim proceeding on less information than
  // it needed. A warning is not a decision.
  let record;
  try {
    const raw = await factory.getLaunchedToken(launchedToken);
    record = {
      token: String(raw.token ?? raw[0]),
      curve: String(raw.curve ?? raw[1]),
      deployer: String(raw.deployer ?? raw[2]),
      creatorFeeRecipient: String(raw.creatorFeeRecipient ?? raw[3]),
      pairToken: String(raw.pairToken ?? raw[4]),
      exists: Boolean(raw.exists ?? raw[14]),
    };
  } catch (err: any) {
    console.error(`\nCould not read the launch record from ${owning.id}: ${err?.message ?? err}`);
    console.error('Refusing: without it there is no proof these fees belong to this splitter.');
    process.exit(1);
  }

  assertLaunchLineage(record, splitterAddress, launchedToken, owning);
  line('curve', record.curve);
  line('creator recipient', `${record.creatorFeeRecipient}  == this splitter`);

  // From the factory's own record, never from configuration or a guess.
  const pairToken: string = record.pairToken;
  line('pair token', pairToken);

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
    console.log('\nDry run. Nothing was signed and no credential was read.');
    console.log('Re-run with --execute to claim and split.');
    return;
  }

  /**
   * The operator's own signer, reached for only now.
   *
   * Deliberately NOT `TREASURY_SIGNER_PRIVATE_KEY`. That one is testnet-only, refuses to
   * run under NODE_ENV=production, and belongs to the bot -- whose Turnkey policy exists
   * precisely so that key cannot move funds freely. Naming it here would ask an operator
   * to defeat that on their own laptop.
   *
   * `claimAndSplit` is permissionless and pays only the creator and the treasury, both
   * fixed immutably at the splitter's construction. So any funded wallet can send it, and
   * the sender gains nothing by being the bot.
   */
  const operatorKey = process.env.COLLECTOR_OPERATOR_PRIVATE_KEY;
  if (!operatorKey) {
    console.error('\n--execute needs a signer, and it must not be the bot\'s.');
    console.error('');
    console.error('  COLLECTOR_OPERATOR_PRIVATE_KEY=0x... npm run collect:v2 -- <splitter> --execute');
    console.error('');
    console.error('Any funded wallet works: claimAndSplit is permissionless and pays only the');
    console.error('creator and treasury addresses fixed when the splitter was deployed. The');
    console.error('sender gains nothing by being the treasury, and TREASURY_SIGNER_PRIVATE_KEY');
    console.error('is testnet-only and refuses to run in production anyway.');
    process.exit(1);
  }
  const signer = new ethers.Wallet(operatorKey, provider);
  const splitterAsSigner = splitter.connect(signer) as ethers.Contract;
  line('signing as', await signer.getAddress());

  const creatorAddress = (await splitter.creator()) as string;
  const treasuryAddress = (await splitter.treasury()) as string;
  const evidence: Record<string, unknown>[] = [];
  let failed = false;

  /** Both recipients' balances for one asset, so a claim can be measured rather than
   *  described. A null token means native ETH. */
  async function balances(
    token: string | null
  ): Promise<{ creator: bigint; treasury: bigint; queuedCreator: bigint; queuedTreasury: bigint }> {
    // The queued ledger is sampled alongside the wallet balance, because a share that
    // could not be delivered lands there instead. Reading only the wallet reports owed
    // money as missing money, which sends an operator hunting a theft that did not
    // happen -- and makes the next real shortfall read like more of the same.
    const queued =
      token === null
        ? {
            queuedCreator: (await splitter.claimable(creatorAddress)) as bigint,
            queuedTreasury: (await splitter.claimable(treasuryAddress)) as bigint,
          }
        : {
            queuedCreator: (await splitter.claimableERC20(token, creatorAddress)) as bigint,
            queuedTreasury: (await splitter.claimableERC20(token, treasuryAddress)) as bigint,
          };

    if (token === null) {
      return {
        creator: await provider.getBalance(creatorAddress),
        treasury: await provider.getBalance(treasuryAddress),
        ...queued,
      };
    }
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    return {
      creator: (await erc.balanceOf(creatorAddress)) as bigint,
      treasury: (await erc.balanceOf(treasuryAddress)) as bigint,
      ...queued,
    };
  }

  async function claimAndReconcile(
    label: string,
    token: string | null,
    decimals: number,
    claimed: bigint,
    send: () => Promise<any>
  ): Promise<void> {
    console.log(`\nclaim ${label}...`);
    const before = await balances(token);

    const tx = await send();
    const receipt = await tx.wait();
    line('tx', tx.hash);

    // Fatal, not printed. A reverted claim the script narrates and walks past is a script
    // reporting success for money that never moved.
    if (!receipt || receipt.status !== 1) {
      console.error(`  status  REVERTED -- ${label} did not claim. Stopping.`);
      process.exit(1);
    }
    line('status', 'ok');

    const after = await balances(token);
    const splitterRemaining =
      token === null
        ? await provider.getBalance(splitterAddress)
        : ((await new ethers.Contract(token, ERC20_ABI, provider).balanceOf(splitterAddress)) as bigint);
    const escrowRemaining =
      token === null
        ? ((await new ethers.Contract(escrowAddress, ESCROW_ABI, provider).balanceOf(splitterAddress)) as bigint)
        : ((await splitter.claimableFromEscrow(token)) as bigint);

    // What the splitter holds against a queued claim is not residue: it is money it is
    // deliberately keeping until someone releases it.
    const heldForQueue =
      after.queuedCreator - before.queuedCreator + (after.queuedTreasury - before.queuedTreasury);

    const r = reconcileClaim({
      claimed,
      creatorDelta: after.creator - before.creator,
      treasuryDelta: after.treasury - before.treasury,
      // DELTAS, not absolute balances. A share queued by an earlier run is already owed
      // and is not this claim's doing; counting it here would make this claim appear to
      // have delivered money it never touched.
      queuedCreator: after.queuedCreator - before.queuedCreator,
      queuedTreasury: after.queuedTreasury - before.queuedTreasury,
      escrowRemaining,
      splitterRemaining: splitterRemaining - heldForQueue,
    });

    const fmt = (v: string) => ethers.formatUnits(BigInt(v), decimals);
    line('creator received', `${fmt(r.evidence.creatorDelta)} (expected ${fmt(r.evidence.expectedCreator)})`);
    line('treasury received', `${fmt(r.evidence.treasuryDelta)} (expected ${fmt(r.evidence.expectedTreasury)})`);
    if (BigInt(r.evidence.queuedCreator) > 0n || BigInt(r.evidence.queuedTreasury) > 0n) {
      line('queued for creator', fmt(r.evidence.queuedCreator));
      line('queued for treasury', fmt(r.evidence.queuedTreasury));
    }
    line('left in splitter', fmt(r.evidence.splitterRemaining));
    line('left claimable', fmt(r.evidence.escrowRemaining));
    for (const n of r.notes) console.log(`  note: ${n}`);

    evidence.push({ asset: label, token, txHash: tx.hash, ...r.evidence, ok: r.ok, problems: r.problems });

    if (!r.ok) {
      failed = true;
      console.error(`  RECONCILIATION FAILED for ${label}:`);
      for (const p of r.problems) console.error(`    - ${p}`);
    }
  }

  for (const c of claimable) {
    if (c.amount === 0n) continue;
    await claimAndReconcile(c.symbol, c.token, c.decimals, c.amount, () =>
      splitterAsSigner['claimAndSplit(address)'](c.token)
    );
  }

  if (nativeAmount > 0n) {
    await claimAndReconcile('ETH', null, 18, nativeAmount, () => splitterAsSigner.claimEthAndSplit());
  }

  // Machine-readable, so an operator keeps it beside the transaction hashes rather than
  // re-reading scrollback.
  console.log('\n=== EVIDENCE (JSON) ===');
  console.log(
    JSON.stringify(
      { splitter: splitterAddress, deployment: owning.id, launchedToken, claims: evidence },
      null,
      2
    )
  );

  if (failed) {
    console.error('\n=== RECONCILIATION FAILED ===');
    console.error('At least one claim did not distribute what the contract should have.');
    console.error('Do not treat these fees as settled.');
    process.exit(1);
  }
  console.log('\n=== RECONCILED ===  every claim split exactly, nothing left behind.');
}

main().catch((err) => {
  console.error('Failed:', err?.message ?? err);
  process.exit(1);
});
