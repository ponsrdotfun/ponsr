/**
 * Reads the authoritative core from a running backend and says whether it is acceptable.
 *
 * KEYLESS AND READ-ONLY. One HTTP GET. It constructs no signer, imports no Turnkey module,
 * reads no private key, reserves no nonce and broadcasts nothing.
 *
 * WHAT A PASS MEANS
 * -----------------
 * Keyless readiness EVIDENCE only. It grants no signing or financial authority. It says the
 * chain looked right, through one named endpoint, at one moment.
 *
 * It is NOT a substitute for the canary's own preflight. `phase-b-launch.ts` keeps every
 * live chain, deployment, fee, pair, sellability and budget check it already performs; this
 * may sit in front of those as an additional gate, never in place of them. An endpoint that
 * says yes is easier to satisfy than a chain that does, and the expensive direction is the
 * one that spends money.
 *
 * Usage:
 *   npx tsx scripts/check-core-readiness.ts --url https://ponsr-backend.fly.dev
 *   npx tsx scripts/check-core-readiness.ts --url <base> --timeout-ms 3000 --json
 *   npx tsx scripts/check-core-readiness.ts --url <base> --expect-endpoint 78ccdeee5ef1
 */
import { executableDeployment } from '../src/deployments';
import { fetchAndValidateCore, ValidateOptions } from '../src/coreValidator';
import { parseAddress, parseArgInteger, parseArgWei, parseFingerprint } from '../src/strictParse';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * COMMITTED PRODUCTION INVARIANTS.
 *
 * Every quantity a verdict depends on is pinned HERE or on the command line -- never taken
 * from the response being judged. A validator that reads the cap out of the document it is
 * checking lets that document assert its own headroom, and a run with `capWei` inflated to
 * 10^21 passed with the real cap exhausted before this was fixed.
 *
 * All four are public: the treasury address is on chain, the cap and fee are published by
 * `/status` to anyone, and the endpoint fingerprint is a digest that reveals no URL.
 */
const EXPECTED_LAUNCH_FEE_WEI = 500000000000000n;      // 0.0005 ETH, read live on mainnet
const EXPECTED_CAP_WEI = 10000000000000000n;           // 0.01 ETH daily spend cap
const EXPECTED_TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const EXPECTED_ENDPOINT_FINGERPRINT = '78ccdeee5ef1';  // rpc.mainnet.chain.robinhood.com

function usage(problem: string): never {
  // The offending value is never echoed: an operator can put anything on a command line.
  console.error(`check-core-readiness: ${problem}`);
  console.error('');
  console.error('usage: check-core-readiness.ts --url <base-url> [options]');
  console.error('  --timeout-ms N                 client deadline, default 3000');
  console.error('  --max-age-ms N                 freshness limit, default 30000');
  console.error('  --max-identity-age-ms N        identity age limit, default 900000');
  console.error('  --expect-fee-wei N             default 500000000000000');
  console.error('  --expect-cap-wei N             default 10000000000000000');
  console.error('  --expect-treasury 0x...        default the production treasury');
  console.error('  --require-balance-wei N        default the expected launch fee');
  console.error('  --expect-endpoint <12 hex>     default 78ccdeee5ef1');
  console.error('  --expect-public-launch-enabled  expect the gate OPEN (default: paused)');
  console.error('  --json                         machine-readable output');
  process.exit(2);
}

async function main(): Promise<void> {
  const base = flag('--url');
  if (!base) usage('--url is required');
  const d = executableDeployment();
  const asJson = argv.includes('--json');

  // Strict parsing for every numeric argument. `--samples NaN` and `--timeout-ms -1` are
  // refused rather than silently becoming a nonsense bound.
  const num = (name: string, fallback: number, min = 0): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const v = parseArgInteger(raw, min);
    if (v === null) usage(`${name} must be a non-negative integer`);
    return v;
  };
  const wei = (name: string, fallback: bigint): bigint => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const v = parseArgWei(raw);
    if (v === null) usage(`${name} must be unsigned decimal wei`);
    return v;
  };

  const treasuryRaw = flag('--expect-treasury') ?? EXPECTED_TREASURY;
  const treasury = parseAddress(treasuryRaw);
  if (treasury === null) usage('--expect-treasury must be a 0x-prefixed 20-byte address');

  const fingerprintRaw = flag('--expect-endpoint') ?? EXPECTED_ENDPOINT_FINGERPRINT;
  const fingerprint = parseFingerprint(fingerprintRaw);
  if (fingerprint === null) usage('--expect-endpoint must be 12 lowercase hex characters');

  const expectedFee = wei('--expect-fee-wei', EXPECTED_LAUNCH_FEE_WEI);

  const options: ValidateOptions & { timeoutMs?: number } = {
    expectedChainId: d.chainId,
    expectedDeploymentId: d.id,
    expectedFactory: d.factory,
    expectedLaunchFeeWei: expectedFee,
    // Caller-pinned, never from the response.
    expectedCapWei: wei('--expect-cap-wei', EXPECTED_CAP_WEI),
    expectedTreasury: treasury,
    // Default floor is the fee: below it a launch cannot even be paid for. Full gas
    // sufficiency stays the direct canary preflight's job and is not claimed here.
    requiredTreasuryBalanceWei: wei('--require-balance-wei', expectedFee),
    expectedEndpointFingerprint: fingerprint,
    maxAgeMs: num('--max-age-ms', 30_000),
    maxIdentityAgeMs: num('--max-identity-age-ms', 15 * 60 * 1000),
    // Production runs paused, and the pause protects user traffic rather than gating an
    // operator canary. Expecting `false` is the normal, correct expectation.
    expectPublicLaunchEnabled: argv.includes('--expect-public-launch-enabled'),
    // Comfortably below the server's own core budget, so a client timeout means the server
    // is slow rather than that the two deadlines merely raced.
    timeoutMs: num('--timeout-ms', 3000, 1),
  };

  const result = await fetchAndValidateCore(base, options);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  }

  const e = result.evidence;
  console.log('CORE READINESS -- keyless, read-only, nothing signed or broadcast\n');
  console.log(`  verdict     ${result.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  authority   ${result.authority}`);
  console.log(`  round trip  ${result.elapsedMs} ms`);
  if (e) {
    console.log(`  endpoint    ${e.endpointOrigin ?? 'unknown'} (fingerprint ${e.observedThrough ?? 'none'})`);
    console.log(`  chain       ${e.chainId} (expected ${e.expectedChainId}), block ${e.block}`);
    console.log(`  deployment  ${e.deploymentId} (${e.factory})`);
    console.log(`  identity    ${e.identity ? `${e.identity.ok ? 'match' : 'MISMATCH'}, ${e.identity.fromCache ? `cached ${e.identity.ageMs}ms` : 'measured now'}` : 'absent'}`);
    console.log(`  launch fee  ${e.launchFeeWei ?? 'UNREADABLE'} wei`);
    console.log(`  readiness   ${e.readiness ? `ready=${e.readiness.ready} complete=${e.readiness.complete} onChain=${e.readiness.canLaunchOnChain}` : 'absent'}`);
    console.log(`  treasury    ${e.treasuryAddress ?? 'unknown'} balance ${e.treasuryBalanceWei ?? 'UNREADABLE'} wei`);
    console.log(`  rolling 24h ${e.rolling24hWei ?? 'UNKNOWN'} of ${e.capWei} wei`);
    console.log(`  public gate ${e.publicLaunchEnabled}`);
    console.log(`  core cost   ${e.elapsedMs} ms`);
    if (e.dependencies?.length) {
      console.log('  dependencies:');
      for (const dep of e.dependencies) {
        console.log(`    ${String(dep.ms).padStart(6)} ms  ${dep.name.padEnd(20)} ${dep.outcome}${dep.shared ? ' [batched]' : ''}`);
      }
    }
  }
  if (!result.pass) {
    console.log('\n  failures:');
    for (let i = 0; i < result.failures.length; i++) {
      console.log(`    ${result.failures[i]}: ${result.explanations[i]}`);
    }
  }
  console.log(
    `\n  A PASS is evidence, not permission. The launch path keeps its own direct preflight\n` +
      `  checks; this does not replace them and confers no authority to sign or spend.`
  );
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  // Deliberately terse: a thrown fetch error carries the URL, and a base URL can carry
  // credentials.
  console.error('check-core-readiness: the check could not be completed');
  void err;
  process.exit(2);
});
