import * as fs from 'fs';
import * as path from 'path';

/**
 * Whether the runbook can actually be run.
 *
 * A runbook is read once, under pressure, by somebody who did not write it. Every
 * instruction in it is either executable or it is a trap, and the traps only surface at
 * the moment they matter most.
 *
 * Three had accumulated:
 *
 *   `fly scale count 0` followed by `fly ssh console` -- with no machines there is
 *   nothing to SSH into, so the backup could not be taken and the restore could not be
 *   run. The sequence read as careful and was impossible.
 *
 *   `chown <user>:<group>` -- an angle-bracket placeholder in a command an operator is
 *   meant to paste. They will guess, and guessing wrong produces a process that starts,
 *   listens, and cannot write.
 *
 *   "Deploy the previous release" -- not a thing anybody can type. A rollback needs an
 *   image digest or a release number captured before the change, not a description.
 */

const RUNBOOK = path.join(__dirname, '../../docs/ROLLOUT-RUNBOOK.md');
/**
 * Normalised, because this file is read on Windows and in CI.
 *
 * The first version matched a bash fence followed by a bare newline and found NOTHING in
 * a CRLF checkout -- so every assertion below ran against an empty string and passed
 * vacuously. That is the exact failure mode this whole pass has been about, arriving in
 * the test written to prevent it.
 */
const text = fs.readFileSync(RUNBOOK, 'utf8').split('\r\n').join('\n');

/** Just the shell, so prose mentioning a command is not mistaken for one. */
const shell = (text.match(/```bash\n([\s\S]*?)```/g) ?? []).join('\n');

describe('SQLite maintenance commands match the shipped PID-1 runtime', () => {
  it('uses the shipped keyless CLI, never sqlite3, pkill, or an invented supervisor', () => {
    expect(shell).toMatch(/npm run maintenance:db -- backup/);
    expect(shell).toMatch(/npm run maintenance:db -- rehearse/);
    expect(shell).toMatch(/npm run maintenance:db -- restore/);
    expect(shell).not.toMatch(/\bsqlite3\b|\bpkill\b|supervisorctl/);
  });

  it('backs up online but fences restore by stopping the app machine and using a separate maintenance machine', () => {
    const backup = shell.indexOf('npm run maintenance:db -- backup');
    const stop = shell.indexOf('fly machine stop');
    const maintenance = shell.indexOf('fly machine run');
    const restore = shell.indexOf('npm run maintenance:db -- restore');
    expect(backup).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(backup);
    expect(maintenance).toBeGreaterThan(stop);
    expect(restore).toBeGreaterThan(maintenance);
    expect(shell).not.toMatch(/fly\s+scale\s+count\s+0/);
  });

  it('keeps host-only fly commands out of remote command strings', () => {
    const remoteCommands = [...shell.matchAll(/fly ssh console[^\n]*-C\s+"([^"]*)"/g)].map((match) => match[1]);
    expect(remoteCommands.some((command) => /\bfly\b/.test(command))).toBe(false);
  });

  it('uses strict JSON manifests and copies one off-machine', () => {
    expect(text).toMatch(/strict JSON manifest/i);
    expect(shell).toMatch(/backup-manifest-\$STAMP\.json/);
    expect(shell).toMatch(/fly ssh sftp get/);
    expect(shell).not.toMatch(/awk .*MANIFEST|grep -q .*SHA/);
  });

  it('passes explicit offline acknowledgement and validates integrity, FKs, and launch count', () => {
    expect(shell).toMatch(/rehearse[\s\S]{0,300}--offline/);
    expect(shell).toMatch(/restore[\s\S]{0,300}--offline/);
    expect(text).toMatch(/integrity_check/);
    expect(text).toMatch(/foreign_key_check/);
    expect(text).toMatch(/launchCount/);
  });

  it('does not claim this process was live-tested', () => {
    expect(text).toMatch(/not LIVE-tested/i);
    expect(text).not.toMatch(/LIVE-tested successfully/i);
  });
});

describe('rollback names something immutable', () => {
  it('captures a release and image digest before the change', () => {
    expect(shell).toMatch(/fly releases/);
    expect(text).toMatch(/rollback-target\.txt/);
  });

  it('does not tell the operator to deploy "the previous release"', () => {
    // Not a thing anybody can type.
    expect(text).not.toMatch(/`fly deploy` the previous release/i);
  });

  it('names an exact revert for the website', () => {
    expect(text).toMatch(/git revert -m 1/);
  });

  it('checks deployment identity after rolling back', () => {
    expect(shell).toMatch(/select\(\.name=="deployment"\)[\s\S]{0,120}pons-v1/);
  });
});

describe('the collector section matches the collector', () => {
  it('shows a keyless dry run', () => {
    expect(text).toMatch(/no key is read|keyless/i);
  });

  it('names the operator credential for execute', () => {
    expect(shell).toMatch(/COLLECTOR_OPERATOR_PRIVATE_KEY=/);
  });

  it('tells the operator not to use the bot key', () => {
    expect(text).toMatch(/Do not use the bot's key/i);
  });

  it('says plainly that execute signs and broadcasts', () => {
    expect(text).toMatch(/SIGNS and BROADCASTS/);
  });

  it('runs signer-active commands from backend', () => {
    // `npm run signer:...` does not exist at the repository root, and a command that
    // fails at the root is an invitation to improvise an npx fallback.
    expect(text).toMatch(/cd backend/);
  });
});

describe('admin and mutation scripts are prohibited here', () => {
  it('says so explicitly', () => {
    expect(text).toMatch(/Never run an admin or mutation script/i);
  });

  it('names the deny-all probe as the reason', () => {
    expect(text).toMatch(/turnkey-policy-probe/);
  });

  it('labels the signing gates as signer-active', () => {
    expect(text).toMatch(/signer-active/);
  });
});
