import { PonsDeployment, deploymentById, executableDeployment } from './deployments';
import { Outcome, describeOutcome } from './turnkeyOutcome';
import {
  ALL_PROBES,
  PROBE_LABELS,
  PolicyVerdict,
  ProbeOutcomes,
  classifyPolicy,
  verdictExitCode,
} from './turnkeyVerdict';

/**
 * THE CLI'S DECISION, SEPARATED FROM ITS SIGNING.
 *
 * `turnkey-verify-policy.ts` printed `=== NOT SAFE YET ===` and then EXITED 0. The branch
 * fell out of the async function without setting `process.exitCode`, which was set only on
 * the INCONCLUSIVE and PASS paths.
 *
 * That is the same defect the verdict rewrite set out to fix, one layer up. The old script
 * asked whether v1 was allowed and left the answer out of the verdict; the new one
 * computed the verdict correctly and left it out of the EXIT CODE. `classifyPolicy` was
 * tested across ten cases and `verdictExitCode` with it -- and nothing tested that the
 * script consumed either. A correct function beside a composition that ignores it.
 *
 * It matters because the ceremony's acceptance gate is literally "final exit 0 and the
 * PASS matrix". With the defect, exit 0 was satisfied by the exact state the ceremony
 * exists to remove.
 *
 * So the decision lives here, returns the code it decided, and the script's only job is to
 * print the lines and set that code once. This module makes NO network request, constructs
 * no Turnkey client, and asks for no signature; it can therefore be driven with synthetic
 * outcomes in a test.
 */

export interface VerificationInput {
  outcomes: ProbeOutcomes;
  /** Public operational identifiers, for the header. Never credentials. */
  signer: string;
  target: PonsDeployment;
  superseded: PonsDeployment;
  v1: PonsDeployment;
  /** The deployment a rollout is being gated on, when one was named. */
  rolloutTarget?: PonsDeployment | null;
}

export interface VerificationOutput {
  verdict: PolicyVerdict;
  /** 0 only for PASS. Every other terminal state is nonzero. */
  exitCode: number;
  lines: string[];
}

const pad = (label: string, value: unknown): string => `  ${label.padEnd(30)} ${value}`;

/**
 * Decides and renders. Never exits, never prints, never signs.
 *
 * The rollout gate is folded in here rather than left beside the verdict: a PASS matrix
 * with a denied rollout target is not a pass for the rollout, and keeping that comparison
 * in the caller is how the exit code got dropped in the first place.
 */
export function renderVerification(input: VerificationInput): VerificationOutput {
  const { outcomes, target, superseded, v1, rolloutTarget = null } = input;
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);

  say('=== VERIFYING THE BOT POLICY ===');
  say(pad('signer', input.signer));
  say(pad('v1 factory (deny-test only)', v1.factory));
  say(pad('current factory', `${target.factory}  (${target.id})`));
  say(pad('superseded factory', `${superseded.factory}  (not launched through)`));
  say(pad('bot launches through', `${target.id}  <- the one that has to be ALLOWED`));
  say();

  say(pad('1. tx to the v1 factory', describeOutcome(outcomes.v1Factory, 'denied')));
  say(pad('2. tx to the superseded v2 factory', describeOutcome(outcomes.legacyFactory, 'denied')));
  say(pad('3. tx to the CURRENT factory', describeOutcome(outcomes.currentFactory, 'allowed')));
  if (rolloutTarget) say(pad('rollout target', `${rolloutTarget.id}  <- must be ALLOWED`));
  say(pad('4. zero-value contract creation', describeOutcome(outcomes.zeroValueCreation, 'allowed')));
  say(pad('5. contract creation CARRYING FUNDS', describeOutcome(outcomes.fundedCreation, 'denied')));
  say(pad('6. tx to an arbitrary address', describeOutcome(outcomes.arbitraryDestination, 'denied')));
  say();

  const verdict = classifyPolicy(outcomes);
  // Only an executable target can be named -- refused before this is reached -- so the
  // rollout gate is the current probe. Never a superseded one, which is a DENY test and
  // would make "the rollout target is allowed" mean its opposite.
  const rolloutOk = !rolloutTarget || outcomes.currentFactory.kind === 'allowed';

  if (verdict.kind === 'inconclusive') {
    say('=== INCONCLUSIVE ===');
    say(`  ${verdict.unknown.length} of ${ALL_PROBES.length} checks could not be asked, so this run proves nothing.`);
    for (const p of verdict.unknown) say(`    - ${PROBE_LABELS[p]}`);
    say('  The most common cause is the Turnkey organisation being over its signing');
    say('  quota, which disables signing for everything and is not a policy problem.');
    say('  Nothing here says the policy is wrong, and nothing says it is right.');
    return { verdict, exitCode: verdictExitCode(verdict), lines };
  }

  if (verdict.kind === 'pass' && rolloutOk) {
    say('=== PASSED ===');
    say(`The bot can launch on ${target.id} and deploy splitters, and`);
    say('cannot move funds anywhere else, including by attaching them to a deploy.');
    say('Both superseded factories are denied.');
    say('');
    say('Safe to set TURNKEY_POLICY_CONFIRMED=true in backend/.env.');
    return { verdict, exitCode: 0, lines };
  }

  say('=== NOT SAFE YET ===');
  if (verdict.kind === 'not-safe') for (const p of verdict.problems) say(`  ${p}`);
  if (rolloutTarget && !rolloutOk) {
    say(`  The rollout target ${rolloutTarget.id} is DENIED by the policy.`);
    say('  The next runbook step launches through it, producing a bot refused by');
    say('  its own signer after the splitter is paid for.');
  }
  if (outcomes.fundedCreation.kind === 'allowed') {
    say('  THE TREASURY IS DRAINABLE BY THIS KEY.');
    say('  Turnkey signed a contract creation carrying funds. A creation has no');
    say('  destination, so the arbitrary-address check above cannot see it: the value');
    say('  lands in a contract whose code the sender chooses. One transaction empties');
    say('  the hot wallet, and every destination-only check still reports green.');
    say('  Do NOT claim anywhere that a leak of this key costs only launches.');
    say('  Closing it is an operator action -- see docs/TURNKEY-CREATION-AUTHORITY.md');
  }
  if (outcomes.v1Factory.kind === 'allowed' || outcomes.legacyFactory.kind === 'allowed') {
    say('  A superseded factory is still an allowed destination. Removing it is an');
    say('  owner ceremony -- see docs/TURNKEY-V1-REVOCATION-CEREMONY.md, and read the');
    say('  ordering there first: the v1 rule also carries the only zero-value');
    say('  contract-creation clause, so deleting it alone leaves a bot that can launch');
    say('  and then cannot deploy its splitter.');
  }
  if (outcomes.currentFactory.kind !== 'allowed') {
    say('  Fix: powershell -File scripts\\apply-v2-policy.ps1 -Execute');
  }
  // NOT SAFE is a terminal verdict like any other, and it carries its own code. Falling
  // out of here without one is exactly the bug this module exists to make impossible.
  return { verdict, exitCode: verdictExitCode(verdict), lines };
}

export type TargetArgResult =
  | { kind: 'ok'; rolloutTarget: PonsDeployment | null }
  | { kind: 'usage'; exitCode: 2; lines: string[] };

/**
 * The rollout target, resolved and refused BEFORE anything is constructed or signed.
 *
 * A usage error must not cost a Turnkey client, a provider, a nonce read or six signing
 * requests. It must also be a deployment the bot could actually launch through: naming a
 * superseded one used to be accepted and then checked against the v1 probe, which is a
 * DENY test, so "the rollout target is allowed" would have meant the opposite.
 */
export function resolveTargetArg(argv: readonly string[]): TargetArgResult {
  const raw = argv.find((a) => a.startsWith('--target-deployment='))?.slice('--target-deployment='.length);
  if (raw === undefined) return { kind: 'ok', rolloutTarget: null };

  let d: PonsDeployment;
  try {
    d = deploymentById(raw);
  } catch {
    // The id is an operational identifier, not a credential, so naming it is safe and
    // makes the refusal actionable.
    return {
      kind: 'usage',
      exitCode: 2,
      lines: [
        `--target-deployment names "${raw}", which is not a known deployment.`,
        `Known: ${['pons-v1', 'pons-v2-legacy-7e1', executableDeployment().id].join(', ')}`,
      ],
    };
  }
  if (!d.executable) {
    return {
      kind: 'usage',
      exitCode: 2,
      lines: [
        `--target-deployment names ${d.id}, which is not executable ` +
          `(superseded by ${d.supersededBy ?? 'the current deployment'}).`,
        'Rollback is a previous application image, not a superseded factory.',
      ],
    };
  }
  return { kind: 'ok', rolloutTarget: d };
}
