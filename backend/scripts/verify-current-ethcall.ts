/**
 * The exact production launch, simulated against the live factory. Nothing broadcast.
 *
 *   npx tsx scripts/verify-current-ethcall.ts
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FORK REHEARSAL
 * -------------------------------------------------
 * The fork proves the whole economic story -- launch, trade, fee, split -- against a
 * private copy of mainnet at a pinned block. This proves one narrower thing against the
 * REAL chain as it stands right now: that the bytes the bot would actually send are
 * accepted by the contract that would actually receive them.
 *
 * Both are needed. A fork can drift from mainnet the moment pons changes a setting; an
 * `eth_call` cannot tell you what happens after the launch. Neither authorises a
 * broadcast.
 *
 * THE MUTATIONS ARE THE POINT
 * ---------------------------
 * A single passing simulation proves the call works today. It does not prove the guards
 * would catch it going wrong, and a guard nobody has watched fail is not evidence of
 * anything -- the parser eval taught this repository that lesson on 2026-08-06.
 *
 * So each mutation below breaks exactly one thing and requires a deterministic refusal:
 * the old selector, a foreign salt domain, an unapproved pair, a wrong economics
 * digest, an underpaid fee, and a wrong-deployment escrow. A mutation that PASSES is a
 * failure of this script, because it means the chain accepted something it should have
 * rejected.
 *
 * Read-only throughout: `eth_call` with a `from` override, no signer, no key, no value
 * actually transferred.
 */
import { ethers } from 'ethers';
import { config } from '../src/config';
import { createProvider } from '../src/chainClient';
import { createLaunchTarget } from '../src/launchTarget';
import { executableDeployment, deploymentById } from '../src/deployments';
import { launchSalt, PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';
import { splitterEscrowFor, assertEscrowMatches } from '../src/splitterDeployer';

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
/** An approved pair with a real market, so economics are genuine rather than a stub. */
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
/** Stands in for the per-launch splitter, which does not exist at simulation time.
 *  §2.7: the preflight must not require deployment gas to have been spent already. */
const PREDICTED_SPLITTER = ethers.getAddress('0x000000000000000000000000000000000000dead');

const fails: string[] = [];
const line = (l: string, v: unknown) => console.log('  ' + String(l).padEnd(38) + v);
function must(label: string, ok: boolean, detail?: string) {
  line(label, ok ? 'ok' : 'FAILED' + (detail ? ' -- ' + detail : ''));
  if (!ok) fails.push(label);
}

/** Runs an eth_call and classifies it, rather than only recording success. */
async function simulate(
  provider: ethers.Provider,
  tx: { to: string; data: string; value: bigint }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await provider.call({ ...tx, from: TREASURY });
    return { ok: true };
  } catch (err: any) {
    // Decode a custom error into something an operator can act on. §2.7 requires that
    // deterministic refusals are never retried as if they were network trouble.
    const data: string | undefined = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    let reason = String(err?.shortMessage ?? err?.message ?? err).slice(0, 90);
    if (typeof data === 'string' && data.length >= 10) {
      try {
        const parsed = new ethers.Interface(PONS_V2_CURRENT_ABI).parseError(data);
        if (parsed) reason = parsed.name;
      } catch {
        reason = `custom error ${data.slice(0, 10)}`;
      }
    }
    return { ok: false, reason };
  }
}

/** A mutation must fail. Passing means the chain accepted what a guard should stop. */
async function mutationMustRevert(
  provider: ethers.Provider,
  label: string,
  tx: { to: string; data: string; value: bigint }
) {
  const r = await simulate(provider, tx);
  must(label, !r.ok, r.ok ? 'ACCEPTED -- the chain took a call that should be refused' : undefined);
  if (!r.ok) line('   refused with', r.reason);
}

(async () => {
  const provider = createProvider();
  const d = executableDeployment();
  const legacy = deploymentById('pons-v2-legacy-7e1');
  const factory = new ethers.Contract(d.factory, PONS_V2_CURRENT_ABI, provider);

  console.log('=== EXACT eth_call AGAINST THE LIVE FACTORY -- ' + d.id + ' ===');
  const chainId = Number((await provider.getNetwork()).chainId);
  line('chain', chainId);
  line('block', await provider.getBlockNumber());
  line('factory', d.factory);
  line('caller (from)', TREASURY);

  // Refuse before checking anything else.
  //
  // backend/.env points at testnet (46630) by design, which is the safe local default.
  // The deployment being verified is a mainnet contract. Run this script as-is and
  // every read comes back empty -- and an empty read is not a neutral result: without
  // this guard the first version reported the runtime hash as
  // e3b0c442…, the sha256 of nothing at all, as though the bytecode simply differed.
  // A verification tool pointed at the wrong chain does not fail loudly by default; it
  // quietly answers a different question.
  if (chainId !== d.chainId) {
    console.error(
      `\nWRONG CHAIN. ${d.id} lives on ${d.chainId}; this RPC is ${chainId}.\n\n` +
        'Nothing was checked. Point a read-only RPC at the right chain for this run only,\n' +
        'without editing backend/.env:\n\n' +
        '  RPC_URL=https://rpc.mainnet.chain.robinhood.com CHAIN_ID=' + d.chainId + ' \\\n' +
        '    npx tsx scripts/verify-current-ethcall.ts\n'
    );
    process.exit(1);
  }

  console.log('\n1  Identity: the registry is a claim, the chain is the authority');
  const code = await provider.getCode(d.factory);
  const runtimeSha = ethers.sha256(code).slice(2);
  must('runtime length matches', (code.length - 2) / 2 === d.runtimeBytecodeLength, `${(code.length - 2) / 2}`);
  must('runtime sha256 matches', runtimeSha === d.runtimeBytecodeSha256, runtimeSha.slice(0, 16) + '…');
  const liveEscrow = String(await factory.feeEscrow());
  must('feeEscrow matches registry', liveEscrow.toLowerCase() === d.feeEscrow.toLowerCase(), liveEscrow);
  must('registry escrow is not the old one', liveEscrow.toLowerCase() !== legacy.feeEscrow.toLowerCase());

  console.log('\n2  The gate, read live and reported in parts');
  const [enabled, whitelisted, canLaunch, cfgCount, fee] = await Promise.all([
    factory.launchEnabled(),
    factory.whitelistedLaunchers(TREASURY),
    factory.canLaunch(TREASURY),
    factory.launchConfigCount(),
    factory.launchFee(),
  ]);
  line('launchEnabled', enabled);
  line('whitelistedLaunchers(treasury)', whitelisted + '   <- not durable');
  line('canLaunch(treasury)', canLaunch);
  line('launchConfigCount', cfgCount.toString());
  line('launchFee (live, not hardcoded)', ethers.formatEther(fee) + ' ETH');
  must('canLaunch(treasury) is true', Boolean(canLaunch), 'the public gate is shut');

  console.log('\n3  Pair approval, read live');
  const approved = await factory.approvedPairTokens(AAPL);
  must('AAPL approved right now', Boolean(approved));

  console.log('\n4  The bot’s own calldata, via the production encoder');
  const target = createLaunchTarget(provider);
  const built = await target.build(
    {
      tokenName: 'Simulation Token',
      tokenSymbol: 'SIMUL',
      description: 'exact-call verification, never broadcast',
      splitterAddress: PREDICTED_SPLITTER,
      tweetId: 'ethcall-gate-1',
      pairAsset: {
        address: AAPL,
        symbol: 'AAPL',
        name: 'Apple',
        decimals: 18,
        graduationThreshold: null,
      },
    },
    BigInt(fee)
  );
  // Asked of the target, not of the calldata. The bytes carry no deployment id -- that
  // is what made the original mistake invisible -- so the assertion has to interrogate
  // the object that chose the destination.
  must('target bound to the executable deployment', target.deployment?.id === d.id, String(target.deployment?.id));
  must('salt-bearing selector 0xf35abbcf', built.data.slice(0, 10) === d.launchSelector, built.data.slice(0, 10));
  must('addressed to the current factory', built.to.toLowerCase() === d.factory.toLowerCase());
  must('value is exactly the live fee', BigInt(built.value) === BigInt(fee), String(built.value));
  line('calldata bytes', (built.data.length - 2) / 2);

  console.log('\n5  The simulation that matters');
  const exact = { to: built.to, data: built.data, value: BigInt(built.value) };
  const result = await simulate(provider, exact);
  must('exact production call PASSES', result.ok, result.ok ? undefined : (result as any).reason);

  console.log('\n6  Mutations -- each must be refused, deterministically');

  // The migration's root cause, reproduced. The superseded encoding on the current
  // factory: right destination, wrong four bytes.
  await mutationMustRevert(provider, 'old selector 0xa41d5f2b refused', {
    ...exact,
    data: '0xa41d5f2b' + built.data.slice(10),
  });

  // A salt from another domain. Not invalid bytes -- a valid salt that belongs to a
  // different factory, which is exactly what reusing v1's saltForTweet would produce.
  const foreignSalt = launchSalt({ chainId: d.chainId, factory: legacy.factory }, 'ethcall-gate-1');
  const ownSalt = launchSalt(d, 'ethcall-gate-1');
  must('salt is domain-separated by factory', foreignSalt !== ownSalt);
  must('salt is reproducible for one request', launchSalt(d, 'ethcall-gate-1') === ownSalt);
  must('salt differs per request', launchSalt(d, 'ethcall-gate-2') !== ownSalt);

  // An unapproved pair. Uses the fee escrow's own address as a pair token: a real
  // contract, certainly not an approved trading pair.
  const unapprovedPair = await target.build(
    {
      tokenName: 'Simulation Token',
      tokenSymbol: 'SIMUL',
      description: 'exact-call verification, never broadcast',
      splitterAddress: PREDICTED_SPLITTER,
      tweetId: 'ethcall-gate-1',
      pairAsset: {
        address: d.feeEscrow,
        symbol: 'NOPE',
        name: 'Not approved',
        decimals: 18,
        graduationThreshold: null,
      },
    },
    BigInt(fee)
  ).catch((e: any) => ({ to: exact.to, data: exact.data, value: exact.value, refusedLocally: String(e.message) }) as any);
  if ((unapprovedPair as any).refusedLocally) {
    must('unapproved pair refused before the chain', true);
    line('   refused with', String((unapprovedPair as any).refusedLocally).slice(0, 80));
  } else {
    await mutationMustRevert(provider, 'unapproved pair refused', {
      to: unapprovedPair.to,
      data: unapprovedPair.data,
      value: BigInt(unapprovedPair.value),
    });
  }

  // A wrong economics digest. The last 64 bytes of TokenParams are `expectedEconomics`
  // then `salt`; flipping a byte in the digest is what a stale economics read looks
  // like on the wire.
  const flipped = built.data.slice(0, -130) + (built.data.slice(-130, -129) === 'f' ? '0' : 'f') + built.data.slice(-129);
  await mutationMustRevert(provider, 'wrong economics digest refused', {
    ...exact,
    data: flipped,
  });

  // Underpayment. The fee is read live precisely because it is owner-settable.
  await mutationMustRevert(provider, 'underpaid fee refused', {
    ...exact,
    value: BigInt(fee) - 1n,
  });

  console.log('\n7  Escrow binding -- the failure with no recovery');
  line('splitter would bind', splitterEscrowFor(d));
  must('splitter escrow == live factory escrow', splitterEscrowFor(d).toLowerCase() === liveEscrow.toLowerCase());
  let refusedOldEscrow = false;
  try {
    assertEscrowMatches(d, legacy.feeEscrow);
  } catch {
    refusedOldEscrow = true;
  }
  must('old escrow refused before any deploy', refusedOldEscrow);

  console.log('');
  if (fails.length === 0) {
    console.log('=== PASSED -- exact production calldata is accepted by the live factory ===');
    console.log('Nothing was broadcast, no key was used, and no value moved.');
    console.log('This does NOT authorise a mainnet launch and proves nothing about Turnkey.');
  } else {
    console.log('=== FAILED ===');
    for (const f of fails) console.log('  - ' + f);
  }
  process.exitCode = fails.length === 0 ? 0 : 1;
})().catch((e) => {
  console.error('FAILED:', String(e?.message ?? e).slice(0, 300));
  process.exit(1);
});
