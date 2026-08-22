/**
 * A full launch through the pons deployment that is actually live, on a private copy
 * of mainnet.
 *
 *   FORK=1 CHAIN_ID=4663 RPC_URL=https://rpc.mainnet.chain.robinhood.com \
 *     npx hardhat run --no-compile scripts/fork-rehearsal.js
 *
 * WHAT CHANGED, AND WHY THE OLD VERSION WAS MISLEADING
 * ----------------------------------------------------
 * This script used to hardcode `0x7E1EAbd5…` and its escrow, and it impersonated the
 * pons owner to open a gate that was closed. Both were true of a superseded
 * deployment. pons moved to `0x7eD598…EC7e` on 2026-08-03, left launching open to
 * everyone, and has taken over 1,900 launches through it since -- so the rehearsal was
 * proving that a contract nobody uses would accept calldata nobody sends.
 *
 * It now takes the executable deployment from the registry, proves the runtime
 * bytecode on the fork is the one the registry describes, and uses the gate exactly as
 * it stands. Nothing is impersonated except the treasury itself, which is only
 * necessary because this machine holds no signer for it.
 *
 * The calldata comes from `backend/src/launchTarget.ts` through a child process. A
 * rehearsal that re-implements the thing it is rehearsing proves the reimplementation.
 *
 * WHAT IT STILL DOES NOT PROVE
 * ----------------------------
 *   - That the Turnkey policy will sign for this factory. That is a separate,
 *     credentialed check and this script does not touch it.
 *   - Gas, reorgs, congestion, or anything about a live network.
 *   - That pons will not close the public gate or migrate again.
 *
 * A PASS here does not authorise a mainnet launch.
 */
const { ethers } = require('hardhat');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const artifacts = require('../contracts-test/artifacts.json');
const curveAbi = require('../backend/src/abi/ponsV2CurrentBondingCurveAbi.json');

// Read straight from the backend's registry so the two cannot drift.
const {
  executableDeployment,
  deploymentById,
} = require('../backend/dist/deployments.js');

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const CREATOR = '0x1111111111111111111111111111111111111111';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
/** Any address holding enough AAPL to trade with; on a fork its balance is ours to
 *  borrow, and on mainnet this line means nothing. */
const AAPL_HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];

const line = (l, v) => console.log('  ' + String(l).padEnd(34) + v);
const amt = (v) => ethers.formatUnits(v, 18);
const fails = [];
function must(label, ok, detail) {
  line(label, ok ? 'ok' : 'FAILED' + (detail ? ' — ' + detail : ''));
  if (!ok) fails.push(label);
}

async function impersonate(address) {
  await ethers.provider.send('hardhat_impersonateAccount', [address]);
  await ethers.provider.send('hardhat_setBalance', [address, '0x56BC75E2D63100000']);
  return ethers.getSigner(address);
}

(async () => {
  // Hardhat refuses to execute at the fork block itself, treating it as replaying the
  // forked chain's history. One block on top and everything after runs in a block it
  // mined.
  await ethers.provider.send('hardhat_mine', ['0x1']);

  const d = executableDeployment();
  const legacy = deploymentById('pons-v2-legacy-7e1');
  const factoryAbi = require(`../backend/src/${d.abiPath}`);

  console.log('=== FORKED REHEARSAL — ' + d.id + ' ===');
  line('chain', (await ethers.provider.getNetwork()).chainId.toString());
  line('block', await ethers.provider.getBlockNumber());
  line('factory', d.factory);

  // The registry is a claim about the chain. This is where it gets checked.
  const code = await ethers.provider.getCode(d.factory);
  if (code === '0x') throw new Error('not forked -- run with FORK=1');
  const runtimeSha = crypto.createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
  must('runtime length matches', (code.length - 2) / 2 === d.runtimeBytecodeLength, `${(code.length - 2) / 2}`);
  must('runtime sha256 matches', runtimeSha === d.runtimeBytecodeSha256, runtimeSha.slice(0, 16) + '…');

  const factory = new ethers.Contract(d.factory, factoryAbi, ethers.provider);
  const liveEscrow = String(await factory.feeEscrow());
  must('factory escrow matches registry', liveEscrow.toLowerCase() === d.feeEscrow.toLowerCase(), liveEscrow);

  const treasury = await impersonate(TREASURY);

  console.log('\n1  The gate, exactly as it stands');
  const [enabled, whitelisted, canLaunch] = await Promise.all([
    factory.launchEnabled(),
    factory.whitelistedLaunchers(TREASURY),
    factory.canLaunch(TREASURY),
  ]);
  line('launchEnabled', enabled);
  line('whitelisted', whitelisted);
  line('canLaunch(treasury)', canLaunch);
  must('no impersonation needed to launch', Boolean(canLaunch), 'the public gate is closed on this fork');

  console.log('\n2  The splitter the backend would deploy');
  // The exact artifact the backend consumes, not a separately compiled copy: a
  // hand-kept second copy going stale is what stranded the first launch's fees.
  const backendArtifact = require('../backend/src/feeSplitterArtifact.json').FeeSplitterV2;
  must(
    'artifact matches contracts build',
    backendArtifact.bytecode === artifacts.FeeSplitterV2.bytecode,
    'backend copy differs from the compile output'
  );

  // The migration's central risk, proven rather than asserted: a splitter bound to the
  // superseded escrow must be refused before gas is spent.
  const { assertEscrowMatches } = require('../backend/dist/splitterDeployer.js');
  let refused = false;
  try {
    assertEscrowMatches(d, legacy.feeEscrow);
  } catch {
    refused = true;
  }
  must('old escrow refused before deploy', refused);

  const sf = new ethers.ContractFactory(backendArtifact.abi, backendArtifact.bytecode, treasury);
  const splitter = await sf.deploy(CREATOR, TREASURY, ethers.ZeroAddress, d.feeEscrow);
  await splitter.waitForDeployment();
  const splitterAddress = await splitter.getAddress();
  line('splitter', splitterAddress);
  must('splitter bound to current escrow', (await splitter.escrow()).toLowerCase() === d.feeEscrow.toLowerCase());

  // The condition that broke fee recovery, reproduced rather than described.
  //
  // The orchestrator deploys the splitter BEFORE the launch that creates the token, so it
  // passes ZeroAddress and `FeeSplitter` stores that immutably. `collect-and-split-v2.ts`
  // read that field and called it the launched token, which meant it could not recover
  // fees from a single bot launch. This asserts the field really is zero, so the
  // resolution proven in step 7 is solving the real problem and not a hypothetical.
  must(
    'splitter token field is zero (as the bot deploys it)',
    (await splitter.token()) === ethers.ZeroAddress
  );

  console.log('\n3  Launching, with the backend’s own calldata');
  const build = (tweetId) =>
    JSON.parse(
      execFileSync('npx', ['tsx', 'scripts/print-v2-calldata.ts', splitterAddress, AAPL, tweetId], {
        cwd: path.join(__dirname, '..', 'backend'),
        encoding: 'utf8',
        shell: true,
      })
        .trim()
        .split('\n')
        .pop()
    );

  const built = build('rehearsal-1');
  must('built for the executable deployment', built.deployment === d.id, built.deployment);
  must('salt-bearing selector', built.selector === d.launchSelector, built.selector);
  must('addressed to the current factory', built.to.toLowerCase() === d.factory.toLowerCase());

  const receipt = await (
    await treasury.sendTransaction({ to: built.to, data: built.data, value: BigInt(built.value) })
  ).wait();
  must('launch confirmed', receipt.status === 1);

  const iface = new ethers.Interface(factoryAbi);
  let token, curveAddress, originalDeployer, creatorRecipient;
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (p && p.name === 'TokenLaunched') {
        token = p.args.token;
        curveAddress = p.args.curve;
        originalDeployer = p.args.originalDeployer ?? p.args.deployer;
        creatorRecipient = p.args.creatorFeeRecipient;
      }
    } catch { /* not ours */ }
  }
  must('TokenLaunched present', Boolean(token));
  const t = new ethers.Contract(token, ['function name() view returns (string)', 'function symbol() view returns (string)'], ethers.provider);
  line('token', (await t.name()) + ' (' + (await t.symbol()) + ')');
  line('address', token);

  // Identity semantics, stated rather than assumed. Through the direct path the
  // treasury is the on-chain deployer; the user receives the creator share through the
  // splitter, and no copy anywhere may claim otherwise.
  if (originalDeployer !== undefined) {
    must('deployer recorded as treasury', String(originalDeployer).toLowerCase() === TREASURY.toLowerCase(), String(originalDeployer));
  }
  if (creatorRecipient !== undefined) {
    must('creator recipient is the splitter', String(creatorRecipient).toLowerCase() === splitterAddress.toLowerCase());
  }

  console.log('\n4  The same request again, which must not mint a second token');
  let duplicateBlocked = false;
  try {
    const again = build('rehearsal-1');
    const r2 = await treasury.sendTransaction({ to: again.to, data: again.data, value: BigInt(again.value) });
    const rec2 = await r2.wait();
    duplicateBlocked = rec2.status !== 1;
  } catch {
    duplicateBlocked = true;
  }
  must('deterministic salt blocks a rerun', duplicateBlocked);

  console.log('\n5  A real buy, with real AAPL');
  const holder = await impersonate(AAPL_HOLDER);
  const spend = ethers.parseUnits('50', 18);
  await (await new ethers.Contract(AAPL, ERC20, holder).transfer(TREASURY, spend)).wait();
  await (await new ethers.Contract(AAPL, ERC20, treasury).approve(curveAddress, spend)).wait();
  const curve = new ethers.Contract(curveAddress, curveAbi, treasury);
  await (await curve.buy(spend, 0n, TREASURY)).wait();
  line('spent', amt(spend) + ' AAPL');
  must('curve credits the current escrow', String(await curve.feeEscrow()).toLowerCase() === d.feeEscrow.toLowerCase());

  console.log('\n6  Claiming the fee back out');
  const claimable = await splitter.claimableFromEscrow(AAPL);
  line('claimable', amt(claimable) + ' AAPL');
  must('a real fee was credited', claimable > 0n);

  const aapl = new ethers.Contract(AAPL, ERC20, ethers.provider);
  const before = { creator: await aapl.balanceOf(CREATOR), treasury: await aapl.balanceOf(TREASURY) };
  await (await splitter['claimAndSplit(address)'](AAPL)).wait();
  const after = { creator: await aapl.balanceOf(CREATOR), treasury: await aapl.balanceOf(TREASURY) };

  const toCreator = after.creator - before.creator;
  const toTreasury = after.treasury - before.treasury;
  const total = toCreator + toTreasury;
  line('creator received', amt(toCreator) + ' AAPL');
  line('treasury received', amt(toTreasury) + ' AAPL');

  // Checked against the contract's own arithmetic. FeeSplitter floors the creator's
  // share and gives the remainder to the treasury, so the ratio prints as 94.99% --
  // asserting a round 9500 bps would fail a correct split.
  const expectedCreator = (total * 9500n) / 10000n;
  must('split matches the contract exactly', toCreator === expectedCreator, `${toCreator} vs ${expectedCreator}`);
  must('nothing left in the splitter', (await aapl.balanceOf(splitterAddress)) === 0n);
  must('nothing left in escrow', (await splitter.claimableFromEscrow(AAPL)) === 0n);

  console.log('\n7  Fee lineage, from a splitter whose token field is zero');
  const { resolveLaunchedToken, assertLaunchLineage, reconcileClaim } =
    require('../backend/dist/splitterLineage.js');

  // Zero field, and no operator argument: this must refuse rather than guess.
  let refusedWithNothing = false;
  try {
    resolveLaunchedToken({ splitterTokenField: ethers.ZeroAddress });
  } catch {
    refusedWithNothing = true;
  }
  must('refuses to guess a token from a zero field', refusedWithNothing);

  // What the bot records: the token from the confirmed receipt.
  const resolvedToken = resolveLaunchedToken({
    splitterTokenField: ethers.ZeroAddress,
    provenanceToken: token,
  });
  must('resolves the launched token from the launch record', resolvedToken.token === token);
  line('source', resolvedToken.source);

  const rec = await factory.getLaunchedToken(token);
  const record = {
    token: String(rec.token ?? rec[0]),
    curve: String(rec.curve ?? rec[1]),
    deployer: String(rec.deployer ?? rec[2]),
    creatorFeeRecipient: String(rec.creatorFeeRecipient ?? rec[3]),
    pairToken: String(rec.pairToken ?? rec[4]),
    exists: Boolean(rec.exists ?? rec[14]),
  };
  must('factory record exists', record.exists === true);
  must('factory names THIS splitter as creator fee recipient',
    record.creatorFeeRecipient.toLowerCase() === splitterAddress.toLowerCase());
  must('pair token comes from the factory record',
    record.pairToken.toLowerCase() === AAPL.toLowerCase());

  let lineageOk = true;
  try {
    assertLaunchLineage(record, splitterAddress, token, d);
  } catch (e) {
    lineageOk = false;
    line('lineage refused', String(e.message).slice(0, 90));
  }
  must('lineage assertion passes for a real launch', lineageOk);

  // And refuses when the factory names somebody else's splitter -- the case that would
  // otherwise pay a stranger's creator.
  let refusedForeign = false;
  try {
    assertLaunchLineage(
      { ...record, creatorFeeRecipient: '0x' + '55'.repeat(20) },
      splitterAddress,
      token,
      d
    );
  } catch {
    refusedForeign = true;
  }
  must('lineage refuses a foreign creator recipient', refusedForeign);

  console.log('\n8  Reconciliation, measured rather than described');
  const recon = reconcileClaim({
    claimed: claimable,
    creatorDelta: toCreator,
    treasuryDelta: toTreasury,
    escrowRemaining: await splitter.claimableFromEscrow(AAPL),
    splitterRemaining: await aapl.balanceOf(splitterAddress),
  });
  must('reconciles exactly', recon.ok, recon.problems.join('; '));
  line('evidence', JSON.stringify(recon.evidence));

  console.log('');
  if (fails.length === 0) {
    console.log('=== PASSED — current deployment, real fee, 95/5, nothing stranded ===');
    console.log('Does NOT authorise mainnet, and proves nothing about the Turnkey policy.');
  } else {
    console.log('=== FAILED ===');
    for (const f of fails) console.log('  - ' + f);
  }
  process.exitCode = fails.length === 0 ? 0 : 1;
})().catch((e) => {
  console.error('FAILED:', String(e.message).slice(0, 300));
  process.exit(1);
});
