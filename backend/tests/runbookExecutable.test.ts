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

describe('the runbook never strands itself', () => {
  it('never scales to zero and then expects a shell', () => {
    // The specific unexecutable sequence, in order.
    const zeroThenSsh = /scale\s+count\s+0[\s\S]{0,600}?fly\s+ssh\s+console/;
    expect(shell).not.toMatch(zeroThenSsh);
  });

  it('does not scale to zero at all in backup or restore', () => {
    expect(shell).not.toMatch(/fly\s+scale\s+count\s+0/);
  });

  it('stops the writer while keeping the machine reachable', () => {
    // Quiescing the writer is the requirement; killing the host is not.
    expect(shell).toMatch(/supervisorctl stop app|pkill -f/);
  });

  it('confirms the writer actually stopped rather than assuming', () => {
    expect(shell).toMatch(/pgrep -f[\s\S]{0,80}writer stopped/);
  });
});

describe('every pasteable command is complete', () => {
  /**
   * `<backend>` is deliberately allowed: it is a hostname the operator supplies once and
   * cannot be filled in here. Anything else in angle brackets inside a command is a blank
   * somebody will guess at.
   */
  const ALLOWED = new Set(['<backend>', '<splitteraddress>', '<launchedtoken>', '<stamp>', '<image', '<merge']);

  it('leaves no unresolved placeholder in a shell command', () => {
    const found = (shell.match(/<[a-zA-Z][^>\s]*>?/g) ?? [])
      .map((p) => p.toLowerCase())
      .filter((p) => !ALLOWED.has(p));
    expect(found).toEqual([]);
  });

  it('replays the recorded owner and mode rather than a placeholder', () => {
    expect(shell).toMatch(/chown \$OWNER/);
    expect(shell).toMatch(/chmod \$MODE/);
    expect(shell).not.toMatch(/chown <user>/);
  });
});

describe('the backup survives the session that made it', () => {
  it('writes a manifest off the machine', () => {
    // $BACKUP dies with the shell. A restore may happen days later, from a different
    // terminal, possibly by someone else.
    expect(shell).toMatch(/backup-manifest-/);
  });

  it('the restore reads that manifest rather than a remembered variable', () => {
    expect(shell).toMatch(/MANIFEST=/);
    expect(shell).toMatch(/BACKUP=\$\(awk/);
  });

  it('verifies the checksum before touching the live file', () => {
    const shaCheck = shell.indexOf('WANT_SHA');
    const replace = shell.indexOf('rm -f /data/bot.sqlite');
    expect(shaCheck).toBeGreaterThan(-1);
    expect(shaCheck).toBeLessThan(replace);
  });

  it('preserves the failed database before replacing it', () => {
    // Whatever went wrong, that file is the only record of everything since the backup,
    // and it is also the evidence.
    const preserve = shell.indexOf('bot.sqlite.failed-');
    const replace = shell.indexOf('rm -f /data/bot.sqlite');
    expect(preserve).toBeGreaterThan(-1);
    expect(preserve).toBeLessThan(replace);
  });

  it('runs integrity and foreign-key checks after restoring', () => {
    expect(shell).toMatch(/integrity_check/);
    expect(shell).toMatch(/foreign_key_check/);
  });

  it('reads application data as well as the pragmas', () => {
    // A file can pass integrity_check and still be the wrong database.
    expect(shell).toMatch(/SELECT COUNT\(\*\) FROM launches/);
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
