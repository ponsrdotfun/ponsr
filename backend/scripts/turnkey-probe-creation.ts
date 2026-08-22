/**
 * Does the bot's key allow a contract creation that MOVES MONEY?
 *
 *   npx tsx scripts/turnkey-probe-creation.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * The bot's policy allows `eth.tx.to == ''` so it can deploy a per-launch FeeSplitter.
 * That condition names the destination and nothing else -- not the value, not the
 * initcode. A contract creation carries `value` like any other transaction, and the ETH
 * lands in the contract being created, whose code the sender chooses.
 *
 * So the question this answers is not academic. If a creation with a large `value` is
 * signed, then anyone holding the bot's API key can deploy a two-line contract that
 * forwards its balance to them and drain the hot treasury in one transaction -- while
 * every existing verifier reports the policy as correct, because they only ever asked
 * about destinations.
 *
 * `docs` and `CLAUDE.md` currently say a leak of this key "costs launches, not the
 * treasury". This script is what decides whether that sentence is true.
 *
 * WHAT IT DOES AND DOES NOT DO
 * ----------------------------
 * It asks Turnkey to SIGN. It never broadcasts, never touches a policy, and never uses
 * root credentials. A signature produced here is discarded; the only thing recorded is
 * whether Turnkey was willing to produce it.
 *
 * A signed creation with nonzero value is a finding, not a failure of this script.
 */
import { ethers } from 'ethers';
import { config } from '../src/config';
import { executableDeployment } from '../src/deployments';
import { classifyTurnkeyOutcome, describeOutcome, Outcome } from '../src/turnkeyOutcome';

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

/**
 * Real initcode for the splitter the bot actually deploys, truncated to keep the probe
 * cheap. Its exact bytes matter only for the "altered initcode" case below.
 */
const SPLITTER_INITCODE_PREFIX = '0x60806040523480156100';
/** Anything else. A contract whose constructor could forward the balance anywhere. */
const HOSTILE_INITCODE = '0x60806040525f80fd00';

function line(label: string, value: unknown) {
  console.log(`  ${String(label).padEnd(44)} ${value}`);
}

async function main() {
  const org = config.TURNKEY_ORGANIZATION_ID;
  if (!org || !config.TURNKEY_API_PUBLIC_KEY || !config.TURNKEY_API_PRIVATE_KEY) {
    console.error('Turnkey is not configured in backend/.env. Nothing probed.');
    process.exit(1);
  }

  const { Turnkey } = require('@turnkey/sdk-server');
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: org,
  }).apiClient();

  const d = executableDeployment();
  const base = { chainId: d.chainId, nonce: 0, gasLimit: 3_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 2 };

  async function attempt(name: string, tx: Record<string, unknown>): Promise<Outcome> {
    try {
      const unsigned = ethers.Transaction.from(tx as any).unsignedSerialized;
      await client.signTransaction({
        signWith: TREASURY,
        unsignedTransaction: unsigned.slice(2),
        type: 'TRANSACTION_TYPE_ETHEREUM',
      });
      return { kind: 'allowed' };
    } catch (err) {
      return classifyTurnkeyOutcome(err);
    }
  }

  console.log('=== CREATION AUTHORITY PROBE (signing only; nothing broadcast) ===');
  line('signer', TREASURY);
  line('deployment', `${d.id} (${d.factory})`);
  console.log('');

  // 1. The legitimate case. The bot must be able to deploy its splitter.
  const zeroValue = await attempt('creation, value 0', {
    ...base,
    to: null,
    data: SPLITTER_INITCODE_PREFIX,
    value: 0n,
  });
  line('1. creation, value 0 (splitter)', describeOutcome(zeroValue, 'allowed'));

  // 2. THE ONE THAT MATTERS. Same shape, with money attached.
  const withValue = await attempt('creation, value 1 ETH', {
    ...base,
    to: null,
    data: SPLITTER_INITCODE_PREFIX,
    value: ethers.parseEther('1'),
  });
  line('2. creation carrying 1 ETH', describeOutcome(withValue, 'denied'));

  /**
   * 3. Different code entirely, still a creation, still zero value.
   *
   * Reported as an ACCEPTED RESIDUAL rather than a failed expectation. The chosen
   * remediation binds `eth.tx.value` on the creation clause and deliberately leaves
   * initcode unbound, so this staying ALLOWED is the design working, not the design
   * failing. It costs gas, never treasury: a zero-value creation has nothing to carry
   * away.
   *
   * It used to assert 'denied', which printed a red cross beside an outcome nobody
   * intended to change. That is worse than cosmetic -- an operator who learns that a
   * correct run shows a failure is an operator who will not notice a real one.
   */
  const hostile = await attempt('creation, foreign initcode', {
    ...base,
    to: null,
    data: HOSTILE_INITCODE,
    value: 0n,
  });
  line('3. creation, unrelated initcode, value 0', describeOutcome(hostile, 'residual'));

  // 4. Control: the treasury's whole balance, to an ordinary address. Known denied.
  const elsewhere = await attempt('transfer elsewhere', {
    ...base,
    to: '0x000000000000000000000000000000000000dEaD',
    data: '0x',
    value: ethers.parseEther('1'),
  });
  line('4. transfer to an arbitrary address', describeOutcome(elsewhere, 'denied'));

  console.log('');
  const unknowns = [zeroValue, withValue, hostile, elsewhere].filter((o) => o.kind === 'unknown');
  if (unknowns.length) {
    console.log('=== INCONCLUSIVE ===');
    console.log(`  ${unknowns.length} of 4 could not be asked, so this run proves nothing.`);
    for (const u of unknowns) console.log(`  ${u.kind === 'unknown' ? u.detail : ''}`);
    process.exitCode = 1;
    return;
  }

  if (withValue.kind === 'allowed') {
    console.log('=== FINDING: THE TREASURY IS DRAINABLE BY THE BOT KEY ===');
    console.log('  Turnkey signed a contract creation carrying 1 ETH.');
    console.log('');
    console.log('  A creation\'s value lands in the contract being created, and the sender');
    console.log('  chooses that contract\'s code. So anyone holding this API key can deploy a');
    console.log('  constructor that forwards its balance to them, in one transaction, without');
    console.log('  ever naming a destination the policy would object to.');
    console.log('');
    console.log('  Every destination-only verifier reports this policy as correct, because a');
    console.log('  creation HAS no destination to check.');
    console.log('');
    console.log('  Any documentation saying a leak of this key costs launches rather than the');
    console.log('  treasury is wrong until this is closed.');
    process.exitCode = 1;
    return;
  }

  /**
   * Case 3 is absent from this verdict on purpose.
   *
   * Only the three cases that the remediation actually promises may gate it: the
   * splitter still deploys, funds cannot ride a creation, and an arbitrary destination
   * is still refused. Adding the residual here would make a correct configuration fail.
   */
  const good = zeroValue.kind === 'allowed' && withValue.kind === 'denied' && elsewhere.kind === 'denied';
  console.log(good ? '=== PASSED ===' : '=== NOT SAFE YET ===');
  if (good) {
    console.log('  The bot can deploy a splitter and cannot attach funds to a creation.');
  }

  // Stated on every run, pass or fail, and whichever way it went. A residual that is
  // only mentioned when it happens to be open is one nobody can audit the history of.
  console.log('');
  console.log('  RESIDUAL (initcode is not bound by the chosen remediation):');
  console.log(
    hostile.kind === 'allowed'
      ? '    OPEN as designed -- any ZERO-VALUE contract may be deployed. Costs gas,\n' +
          '    not treasury. Recorded as accepted residual risk, never as protection.'
      : '    Closed -- a foreign initcode was refused. Better than this design promises;\n' +
          '    do not rely on it until a rule is written that requires it.'
  );
}

main().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
