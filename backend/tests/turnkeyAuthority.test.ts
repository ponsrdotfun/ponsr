import * as fs from 'fs';
import * as path from 'path';

/**
 * Which scripts can change something, and whether they can do it by accident.
 *
 * The operational documents said no repository path performs policy mutations. Three
 * scripts contradicted that, and one of them was genuinely dangerous:
 *
 *   turnkey-allow-v2-factory.ts   createPolicy, gated behind --execute
 *   turnkey-scope-bot-user.ts     createApiKeys/createUsers/createPolicy, rewrites .env
 *   turnkey-policy-probe.ts       createPolicy(DENY-ALL) then deletePolicy -- NO GATE
 *
 * The probe applied a deny-everything policy to the live organisation to find out whether
 * policies bite, and removed it in a `finally`. Run it by accident, or lose the process
 * between those two steps, and signing is disabled org-wide -- which is exactly the state
 * that cost a day on 2026-08-20, arrived at from the other direction.
 *
 * A script that can disable production must not be a script you can run by typing its
 * name. These tests are the inventory, and they fail if a mutation entrypoint stops
 * asking.
 */

const SCRIPTS = path.join(__dirname, '../scripts');
const read = (f: string) => fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
const stripComments = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/** Every Turnkey script, and what it is allowed to do. */
const MATRIX: Array<{
  file: string;
  mutates: boolean;
  signs: boolean;
  writesCredentials: boolean;
}> = [
  { file: 'turnkey-read-policies.ts', mutates: false, signs: false, writesCredentials: false },
  { file: 'turnkey-verify-policy.ts', mutates: false, signs: true, writesCredentials: false },
  { file: 'turnkey-probe-creation.ts', mutates: false, signs: true, writesCredentials: false },
  { file: 'turnkey-policy-probe.ts', mutates: true, signs: true, writesCredentials: false },
  { file: 'turnkey-allow-v2-factory.ts', mutates: true, signs: false, writesCredentials: false },
  { file: 'turnkey-scope-bot-user.ts', mutates: true, signs: false, writesCredentials: true },
];

describe('the Turnkey authority matrix is complete', () => {
  it('every turnkey script in the repository is classified', () => {
    const onDisk = fs
      .readdirSync(SCRIPTS)
      .filter((f) => f.startsWith('turnkey-') && f.endsWith('.ts'))
      .sort();
    expect(onDisk).toEqual(MATRIX.map((m) => m.file).sort());
  });

  it('read-only scripts call nothing that changes state', () => {
    for (const m of MATRIX.filter((x) => !x.mutates)) {
      const code = stripComments(read(m.file));
      expect(code).not.toMatch(/\.createPolicy\(/);
      expect(code).not.toMatch(/\.deletePolicy\(/);
      expect(code).not.toMatch(/\.createApiKeys\(/);
      expect(code).not.toMatch(/\.createUsers\(/);
    }
  });

  it('only scripts marked as writing credentials touch .env', () => {
    for (const m of MATRIX.filter((x) => !x.writesCredentials)) {
      const code = stripComments(read(m.file));
      expect(code).not.toMatch(/writeFileSync\([^)]*\.env/);
    }
  });
});

describe('no mutation runs without being asked twice', () => {
  for (const m of MATRIX.filter((x) => x.mutates)) {
    const code = stripComments(read(m.file));

    it(`${m.file} defines an --execute gate`, () => {
      expect(code).toMatch(/--execute/);
    });

    /**
     * The gate must come BEFORE the mutation, not merely exist somewhere in the file.
     * `turnkey-policy-probe.ts` had no gate at all: it created a deny-all policy on
     * import of `main()`.
     */
    it(`${m.file} refuses before reaching a mutating call`, () => {
      // Any refusing condition on EXECUTE counts -- the probe's is
      // `if (!EXECUTE || !ACKNOWLEDGED)`, which is stricter, not weaker.
      const gate = code.search(/if\s*\(\s*!\s*EXECUTE/);
      const mutation = code.search(/\.(createPolicy|deletePolicy|createApiKeys|createUsers)\(/);
      expect(gate).toBeGreaterThan(-1);
      expect(mutation).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(mutation);
    });

    it(`${m.file} requires an explicit organization target`, () => {
      // A mutation aimed at "whatever the environment says" is a mutation nobody chose.
      expect(code).toMatch(/organizationId/);
    });
  }
});

/**
 * The probe specifically. It is the only script here that can disable signing for the
 * whole organisation, and it used to do so unprompted.
 */
describe('the deny-all probe cannot run unprompted', () => {
  const code = stripComments(read('turnkey-policy-probe.ts'));

  it('needs --execute', () => {
    expect(code).toMatch(/--execute/);
  });

  it('needs a typed acknowledgement as well', () => {
    // --execute is one keystroke away from a shell history entry. Creating a deny-all
    // policy on a live organisation deserves a sentence the operator has to mean.
    expect(code).toMatch(/I-UNDERSTAND-THIS-DISABLES-SIGNING|acknowledge/i);
  });

  it('records the policy id before anything can be lost', () => {
    // If the process dies between create and delete, the id printed beforehand is the
    // only way anyone finds the policy to remove it.
    const created = code.search(/createPolicy\(/);
    const printed = code.search(/PROBE POLICY ID|policyId.*console|console.*policyId/i);
    expect(printed).toBeGreaterThan(-1);
  });

  it('raises an incident when cleanup is not proven', () => {
    expect(code).toMatch(/CLEANUP FAILED|cleanup could not be proven|INCIDENT/i);
  });

  it('verifies the deletion rather than assuming it', () => {
    // deletePolicy returning without throwing is not proof the policy is gone.
    expect(code).toMatch(/getPolicies|verifyDeleted|confirmDeleted/);
  });
});
