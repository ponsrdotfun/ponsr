/**
 * Answers "why is launch readiness slow, and which endpoint is answering?" from the
 * outside, without needing to read a single secret.
 *
 * WHY IT EXISTS
 * -------------
 * On 2026-08-25 `/status` reported `launchpad: down -- launch readiness did not answer
 * within 5000ms`, repeatedly, with `rpc: ok` beside it. Diagnosing that needed three facts
 * nobody could get at: which endpoint the backend was using (RPC_URL is a Fly secret and
 * secret values cannot be read back), how many times the check went to the network, and
 * which call was slow. The conclusion drawn instead -- "the upstream RPC is degrading" --
 * was wrong: the check made four sequential round trips inside one deadline.
 *
 * This is READ-ONLY. It sends `eth_call` and `eth_getCode` and nothing else: no signer is
 * constructed, no key is read, nothing is broadcast, and no state changes anywhere.
 *
 * Usage:
 *   npx tsx scripts/rpc-diagnose.ts                          # the endpoint from RPC_URL
 *   npx tsx scripts/rpc-diagnose.ts --rpc https://host/...    # a specific endpoint
 *   npx tsx scripts/rpc-diagnose.ts --serial                  # per-call attribution
 *   npx tsx scripts/rpc-diagnose.ts --repeat 5                # sample latency variance
 */
import { ethers } from 'ethers';
import { executableDeployment } from '../src/deployments';
import { preflightEnv } from '../src/preflightEnv';
import { probeLaunchPermission, summariseTimings } from '../src/readinessProbe';
import { readCurrentReadiness } from '../src/currentReadiness';
import { describeRpcEndpoint, summariseRpcEndpoint } from '../src/rpcIdentity';
import { IdentityWatch, summariseIdentity } from '../src/identityWatch';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Counts HTTP round trips. Wall-clock varies with the network; this does not, and it is
 *  the property that actually caused the outage. */
class CountingProvider extends ethers.JsonRpcProvider {
  trips: string[][] = [];
  async _send(payload: any): Promise<any> {
    const batch = Array.isArray(payload) ? payload : [payload];
    this.trips.push(batch.map((p: any) => p.method));
    return super._send(payload);
  }
}

async function main(): Promise<void> {
  const d = executableDeployment();
  const url = flag('--rpc') ?? preflightEnv().RPC_URL;
  const serial = argv.includes('--serial');
  const repeat = Number(flag('--repeat') ?? 1);
  const launcher = flag('--launcher') ?? preflightEnv().TREASURY_ADDRESS ?? ethers.ZeroAddress;

  console.log('RPC DIAGNOSTIC -- read-only, nothing is signed or broadcast\n');
  // The identity, never the URL: this output is meant to be pasteable into a report.
  console.log(`  endpoint    ${summariseRpcEndpoint(describeRpcEndpoint(url))}`);
  console.log(`  deployment  ${d.id} (${d.factory}), chain ${d.chainId}`);
  console.log(`  launcher    ${launcher}`);
  console.log(`  mode        ${serial ? 'serial (per-call attribution)' : 'batched (one round trip)'}\n`);

  for (let i = 1; i <= repeat; i++) {
    const p = new CountingProvider(url, d.chainId, { staticNetwork: true });
    const started = Date.now();
    const probe = await probeLaunchPermission(p, launcher, preflightEnv().PONS_LAUNCH_CONFIG_ID, ethers.ZeroAddress, d, { serial });
    const ms = Date.now() - started;

    console.log(`  run ${i}: ${p.trips.length} round trip(s), ${ms} ms total`);
    console.log(`    ${summariseTimings(probe.timings)}`);
    if (probe.verdict) {
      const v = probe.verdict;
      console.log(
        `    ready=${v.ready} canLaunch(on chain)=${v.canLaunchOnChain} launchEnabled=${v.launchEnabled} ` +
          `whitelisted=${v.whitelisted} config=${v.launchConfigUsable} escrow=${v.escrowMatches} fee=${v.feeWei}`
      );
      if (v.reason) console.log(`    refused: ${v.reason}`);
    } else {
      console.log(`    NO VERDICT: ${probe.failure}`);
    }
    if (ms > 5000) {
      console.log('    OVER the 5000ms status budget -- this is what publishes launchpad: down');
    }
    p.destroy();
  }

  // The comparison that names the defect, rather than asserting it.
  const before = new CountingProvider(url, d.chainId, { staticNetwork: true });
  const t0 = Date.now();
  await readCurrentReadiness(before, launcher, preflightEnv().PONS_LAUNCH_CONFIG_ID, ethers.ZeroAddress, d);
  console.log(
    `\n  for comparison, the pre-fix path: ${before.trips.length} round trips, ${Date.now() - t0} ms`
  );
  before.trips.forEach((t, i) => console.log(`    ${i + 1}. ${t.join(', ')}`));
  before.destroy();

  const idp = new CountingProvider(url, d.chainId, { staticNetwork: true });
  const identity = await new IdentityWatch(d).check(idp);
  console.log(`\n  deployment identity: ${summariseIdentity(identity)}`);
  idp.destroy();
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
