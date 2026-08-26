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

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The fee the operator expects, in wei. Stated, never taken from the response being checked. */
const DEFAULT_FEE_WEI = 500000000000000n;

async function main(): Promise<void> {
  const base = flag('--url');
  if (!base) {
    console.error('usage: check-core-readiness.ts --url <base-url> [--timeout-ms N] [--json]');
    console.error('       [--expect-fee-wei N] [--expect-endpoint <fingerprint>] [--max-age-ms N]');
    console.error('       [--expect-public-launch-enabled]');
    process.exit(2);
  }
  const d = executableDeployment();
  const asJson = argv.includes('--json');

  const options: ValidateOptions & { timeoutMs?: number } = {
    expectedChainId: d.chainId,
    expectedDeploymentId: d.id,
    expectedFactory: d.factory,
    expectedLaunchFeeWei: BigInt(flag('--expect-fee-wei') ?? DEFAULT_FEE_WEI.toString()),
    expectedTreasury: flag('--expect-treasury'),
    expectedEndpointFingerprint: flag('--expect-endpoint'),
    maxAgeMs: Number(flag('--max-age-ms') ?? 30_000),
    // Production runs paused, and the pause protects user traffic rather than gating an
    // operator canary. Expecting `false` is therefore the normal, correct expectation.
    expectPublicLaunchEnabled: argv.includes('--expect-public-launch-enabled'),
    // Comfortably below the server's own core budget, so a client timeout means the server
    // is slow rather than that the two deadlines merely raced.
    timeoutMs: Number(flag('--timeout-ms') ?? 3000),
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
