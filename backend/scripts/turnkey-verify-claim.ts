/**
 * Verifies the signer will send a fee claim, and still refuses everything else.
 *
 *   npx ts-node scripts/turnkey-verify-claim.ts
 *
 * Signs, never broadcasts. Nothing reaches the chain and no value moves -- the
 * question is only whether Turnkey is willing to produce a signature, which is
 * where the policy applies.
 *
 * Four probes, and the last three are what make the first one mean anything:
 *
 *   1. claimAndSplit to a real splitter, no value   -> MUST be allowed
 *   2. the same call CARRYING VALUE                 -> MUST be denied
 *   3. a plain transfer to an arbitrary address     -> MUST be denied
 *   4. a launch through the current factory         -> MUST still be allowed
 *
 * Probe 2 is the one worth explaining. A splitter's native `withdraw()` pays
 * `msg.sender`, so ETH that lands in a splitter can be taken by whoever asks
 * first. A rule that allows a splitter as a DESTINATION without binding value to
 * zero lets the treasury fund a contract that hands its balance to a stranger.
 * Allowing an address is not the same as allowing it to be paid.
 *
 * Probe 4 exists because this change widens an authority, and a widening is also
 * an opportunity to break the one that was already working.
 */
import { ethers } from 'ethers';
import { config } from '../src/config';
import { executableDeployment } from '../src/deployments';
import { classifyTurnkeyOutcome, describeOutcome, Outcome } from '../src/turnkeyOutcome';
import { classifyClaimPolicy, ClaimProbeOutcomes, EXIT_CODE, expectationFor, resolvePolicyShape } from '../src/claimPolicyVerdict';

const ARBITRARY = '0x000000000000000000000000000000000000dEaD';
const CLAIM_AND_SPLIT = ethers.id('claimAndSplit(address)').slice(0, 10);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const pad = (label: string, value: unknown) => `  ${label.padEnd(34)} ${value}`;

/**
 * The splitter to probe, and where it came from, said out loud.
 *
 * The committed snapshot is the source when no argument is given, because it is
 * the only list of real splitters this repository holds -- the production
 * database lives in a container the operator's machine cannot read. A stale
 * entry is harmless here: any real splitter address answers the question the
 * probe is asking, which is what the POLICY does with it.
 */
function resolveSplitter(argv: string[]): {
  address: string;
  erc20: string;
  source: string;
  others: string[];
  unlisted: string | null;
  fromArgument: boolean;
} {
  const snapshot = require('../../website/data/launches.json');
  const all = (snapshot.launches ?? []).filter((l: any) => ADDRESS.test(String(l.splitter ?? '')));
  const withSplitter = all[0];

  const given = argv.find((a) => ADDRESS.test(a));
  /**
   * A given splitter is matched back to ITS OWN launch.
   *
   * The ARGUMENT to claimAndSplit is an ERC20, and taking it from whichever
   * launch happens to be first would build calldata pairing one launch's
   * splitter with another launch's token -- a shape the bot never sends, which
   * is precisely the failure mode a signed probe exists to avoid.
   */
  const chosen = given
    ? all.find((l: any) => ethers.getAddress(l.splitter) === ethers.getAddress(given))
    : withSplitter;
  if (given && !chosen) {
    throw new Error(
      `${given} is not a splitter on record. Known: ${all.map((l: any) => l.splitter).join(', ') || 'none'}`
    );
  }
  if (!chosen) {
    throw new Error('No splitter address given and none found in website/data/launches.json');
  }
  return {
    address: ethers.getAddress(chosen.splitter),
    erc20: ethers.getAddress(chosen.token),
    source: given ? `command line (${chosen.symbol})` : `website/data/launches.json (${chosen.symbol})`,
    fromArgument: Boolean(given),
    /**
     * The splitters NOT probed, named so the trap is visible.
     *
     * A policy that binds an ADDRESS LIST covers the addresses in it and no
     * others, so probing one left out of the list reports NOT YET forever while
     * the policy works perfectly. The default here is whichever launch happens
     * to come first in the snapshot, which is nobody's deliberate choice.
     */
    others: all
      .filter((l: any) => ethers.getAddress(l.splitter) !== ethers.getAddress(chosen.splitter))
      .map((l: any) => `${l.symbol} ${ethers.getAddress(l.splitter)}`),
    /**
     * A real splitter that the address list does not name.
     *
     * A second real splitter, whichever one was not probed first. It stands in
     * for a launch that does not exist yet: a real contract a claim could
     * genuinely be sent to, at an address no address-list rule was written for.
     * A made-up address would not do -- the question is what the POLICY does
     * with a destination, and a policy that named it would answer differently.
     */
    unlisted:
      all
        .map((l: any) => ethers.getAddress(l.splitter))
        .find((a: string) => a !== ethers.getAddress(chosen.splitter)) ?? null,
  };
}

(async () => {
  const { Turnkey } = require('@turnkey/sdk-server');
  const { TurnkeySigner } = require('@turnkey/ethers');

  const shape = resolvePolicyShape(process.argv.slice(2));
  if (typeof shape !== 'string') {
    console.error(shape.usage);
    process.exit(2);
  }
  const splitter = resolveSplitter(process.argv.slice(2));
  const target = executableDeployment();

  const organizationId = config.TURNKEY_ORGANIZATION_ID!;
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: organizationId,
  }).apiClient();

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
  const signer = new TurnkeySigner(
    { client, organizationId, signWith: config.TURNKEY_SIGN_WITH! },
    provider
  );
  const from = await signer.getAddress();
  const nonce = await provider.getTransactionCount(from);

  const base = {
    chainId: BigInt(config.CHAIN_ID),
    nonce,
    gasLimit: 500000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 1000000n,
    type: 2,
  };

  // The real calldata shape: the selector plus one ERC20 word. A bare selector
  // would probe a rule that binds on data length differently than the bot does.
  const claimData = `${CLAIM_AND_SPLIT}${'0'.repeat(24)}${splitter.erc20.slice(2).toLowerCase()}`;

  async function attempt(name: string, tx: any): Promise<Outcome> {
    try {
      await signer.signTransaction(tx);
      return { kind: 'allowed' };
    } catch (err) {
      const outcome = classifyTurnkeyOutcome(err);
      if (outcome.kind === 'unknown') console.log(pad(name + ' (could not ask)', outcome.detail.slice(0, 90)));
      return outcome;
    }
  }

  // A selector this signer must never be permitted to send. `withdraw(address)`
  // is chosen deliberately over a made-up four bytes: it is a real function on
  // these very contracts, so a rule that binds the destination and not the
  // calldata really does allow it.
  const OTHER_SELECTOR = ethers.id('withdraw(address)').slice(0, 10);
  const otherData = `${OTHER_SELECTOR}${'0'.repeat(24)}${splitter.erc20.slice(2).toLowerCase()}`;

  const outcomes: ClaimProbeOutcomes = {
    claimToSplitter: await attempt('claim', { ...base, to: splitter.address, data: claimData, value: 0n }),
    fundedClaim: await attempt('funded claim', {
      ...base,
      to: splitter.address,
      data: claimData,
      value: 1000000000000000000n,
    }),
    arbitraryDestination: await attempt('arbitrary destination', {
      ...base,
      to: ARBITRARY,
      value: 1000000000000000000n,
      data: '0x',
    }),
    currentFactory: await attempt('current factory', {
      ...base,
      to: target.factory,
      value: 500000000000000n,
      data: target.launchSelector,
    }),
    claimToUnlistedSplitter: splitter.unlisted
      ? await attempt('unlisted splitter', {
          ...base,
          to: splitter.unlisted,
          data: claimData,
          value: 0n,
        })
      : { kind: 'unknown', detail: 'no second splitter on record to probe' },
    wrongSelectorToSplitter: await attempt('wrong selector', {
      ...base,
      to: splitter.address,
      data: otherData,
      value: 0n,
    }),
  };

  console.log('=== VERIFYING THE CLAIM POLICY ===');
  console.log(pad('signer', from));
  console.log(pad('splitter probed', splitter.address));
  console.log(pad('erc20 argument', splitter.erc20));
  console.log(pad('  from', splitter.source));
  console.log(pad('current factory', `${target.factory}  (${target.id})`));
  console.log(pad('second splitter', splitter.unlisted ?? 'none on record'));
  console.log(pad('expecting', `${shape} policy`));
  /**
   * This script cannot read the policy, only the signer's answers.
   *
   * So it must not label a probe "listed" or "unlisted": with no argument the
   * first launch in the snapshot is PSTONKS, whose splitter an owner-written
   * address list does NOT name -- the labels would then be exactly backwards.
   * The addresses are printed instead, and which of them a rule covers is the
   * operator's knowledge to supply.
   */
  if ((shape === 'address-list' || shape === 'both') && !splitter.fromArgument) {
    console.log(pad('  note', 'no splitter given, so this used the first on record.'));
    console.log(pad('', 'For an address-list rule, pass one the rule actually names.'));
  }
  console.log();
  console.log(pad('1. claim to the probed splitter', describeOutcome(outcomes.claimToSplitter, expectationFor('claimToSplitter', shape))));
  console.log(pad('2. claimAndSplit CARRYING VALUE', describeOutcome(outcomes.fundedClaim, expectationFor('fundedClaim', shape))));
  console.log(pad('3. tx to an arbitrary address', describeOutcome(outcomes.arbitraryDestination, expectationFor('arbitraryDestination', shape))));
  console.log(pad('4. launch through the factory', describeOutcome(outcomes.currentFactory, expectationFor('currentFactory', shape))));
  console.log(pad('5. claim to the SECOND splitter', describeOutcome(outcomes.claimToUnlistedSplitter, expectationFor('claimToUnlistedSplitter', shape))));
  console.log(pad('6. a DIFFERENT selector, probed splitter', describeOutcome(outcomes.wrongSelectorToSplitter, expectationFor('wrongSelectorToSplitter', shape))));
  console.log();

  const verdict = classifyClaimPolicy(outcomes, shape);
  const said: Record<typeof verdict, string> = {
    pass: '=== PASS === the signer will claim, and refuses everything else probed.',
    'not-yet':
      '=== NOT YET === the claim is refused and nothing else is wrong.\n' +
      '    This is the expected state until the owner creates the policy.\n' +
      `    Probed ${splitter.address}.\n` +
      (splitter.others.length
        ? '    NOT probed, and a policy binding an ADDRESS LIST covers only what is in it:\n' +
          splitter.others.map((o) => `      ${o}\n`).join('') +
          '    Pass one as an argument to check it.\n'
        : '') +
      '    See docs/TURNKEY-CLAIM-AUTHORITY.md.',
    unsafe: '=== UNSAFE === an authority is open, or the launch path broke. Do not proceed.',
    inconclusive:
      '=== INCONCLUSIVE === at least one probe could not be ASKED, which is not a denial.\n' +
      '    Nothing here describes the policy. Check the signer credential and quota first.',
  };
  console.log(said[verdict]);
  process.exitCode = EXIT_CODE[verdict];
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
