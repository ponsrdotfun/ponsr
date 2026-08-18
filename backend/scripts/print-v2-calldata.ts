/**
 * Prints the calldata the bot would send for a v2 launch, as JSON.
 *
 * Exists so the forked-mainnet rehearsal can put the BOT'S OWN bytes on the wire
 * rather than a copy rewritten in the test. A rehearsal that re-implements the thing
 * it is rehearsing proves the re-implementation.
 */
import { createLaunchTarget } from '../src/launchTarget';
import { createProvider } from '../src/chainClient';
import { NATIVE_ETH } from '../src/pairTokens';
import { ethers } from 'ethers';

const [splitter, pairToken] = process.argv.slice(2);

(async () => {
  const provider = createProvider();
  const target = createLaunchTarget(provider);
  const built = await target.build(
    {
      tokenName: 'Rehearsal Token',
      tokenSymbol: 'REHRS',
      description: 'forked-mainnet rehearsal',
      splitterAddress: splitter,
      tweetId: 'rehearsal',
      pairAsset: {
        address: pairToken || NATIVE_ETH,
        symbol: 'PAIR',
        name: 'Pair',
        decimals: 18,
        graduationThreshold: null,
      },
    },
    500_000_000_000_000n
  );
  console.log(JSON.stringify({ to: built.to, data: built.data, value: built.value.toString() }));
})().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
