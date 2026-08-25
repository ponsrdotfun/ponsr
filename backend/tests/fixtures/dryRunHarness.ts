/**
 * Drives the REAL canary entrypoint to completion with bounded read-only substitutes.
 *
 * It exists because the completion proof and the mock RPC pull in opposite directions. The
 * preflight verifies the factory's deployed runtime against a recorded sha256 over 24,177
 * bytes, and no mock can produce bytes that hash to it; reading the live chain is not
 * available to a repository-only task. So the four chain reads that cannot be faked at the
 * RPC layer are substituted at the function layer instead, exactly as the entrypoint allows
 * for a dry run and refuses for an executing one.
 *
 * Everything else is the real thing: the real module graph, the real preflight ordering, the
 * real journal, the real output. This process is spawned under the same instrumentation as
 * the plain dry run, so the import and file-open evidence covers this run too.
 *
 * It passes no `--execute` and cannot: the substitutes are dropped when that flag is present.
 */
import { main } from '../../scripts/phase-b-launch';
import { NATIVE_ETH, PairAsset } from '../../src/pairTokens';
import { resolveCanaryPair } from '../../src/canaryPreflight';

/** Every address the run asked the factory's approval map about. Printed at exit. */
const approvalMapReads: string[] = [];

/** A complete PairAsset. Every field the real registry supplies, so nothing reads undefined. */
const ETH_PAIR: PairAsset = {
  symbol: 'ETH',
  name: 'Ether',
  address: NATIVE_ETH,
  decimals: 18,
  graduationThreshold: 4_200_000_000_000_000_000n,
};

main({
  /** The one check a mock RPC provably cannot satisfy. */
  assertIdentity: async () => {
    console.log('  [harness] deployment identity substituted');
  },
  /** The full LaunchReadiness shape, not a convenient subset. */
  readReadiness: async () => ({
    launchEnabled: true,
    whitelisted: true,
    canLaunch: true,
    launchConfigUsable: true,
    launchConfigCount: 1n,
    dexConfigUsable: true,
    pairToken: NATIVE_ETH,
  }),
  /** 0.0005 ETH, the live mainnet reading recorded on 2026-08-06. */
  readFee: async () => 500_000_000_000_000n,
  /**
   * The same shape the real resolver returns, `source` included. An earlier version omitted
   * it and the run printed "paired against ETH (undefined)" -- a harness that completes while
   * producing output the real path never would is not evidence about the real path.
   */
  /**
   * The REAL resolver, with bounded dependencies -- not a substitute for it.
   *
   * This used to return a canned answer, which meant the completion proof never exercised the
   * branch that refused explicit ETH on mainnet. The registry lookup and the approval read are
   * bounded here; the decision itself is the shipped `resolveCanaryPair`.
   *
   * `approvalMapReads` is printed at exit so a test can assert what the run actually asked. For
   * native ETH the correct number is zero: the factory's gate short-circuits on the zero
   * address, and reading `approvedPairTokens(0x0)` is what produced the false revocation.
   */
  resolvePair: async (requested, deps) =>
    resolveCanaryPair(requested, {
      ...deps,
      resolve: async (typed: string) =>
        /^eth$/i.test(typed.trim())
          ? ({ ok: true, asset: ETH_PAIR } as never)
          : ({ ok: false, detail: 'the harness resolves ETH only' } as never),
      isApprovedNow: async (address: string) => {
        approvalMapReads.push(address);
        return false;
      },
    }),
})
  .then(() => {
    console.log(`[harness] approvalMapReads=${approvalMapReads.length}`);
  })
  .catch((err) => {
    console.log(`[harness] approvalMapReads=${approvalMapReads.length}`);
    console.error('\nFAILED:', err?.message ?? err);
    process.exit(1);
  });
