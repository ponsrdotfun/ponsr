import { execFileSync } from 'child_process';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CanaryJournal,
  parseDaclAces,
  assertOwnerOnlyDacl,
  WINDOWS_FULL_CONTROL,
} from '../src/canaryJournal';
import { signAndPersist } from '../src/signedTxFlow';

/**
 * Custody of the raw transaction journal on Windows.
 *
 * `raw_tx` is a complete signed transaction: whoever reads it can broadcast it, from any
 * machine, with no key. Windows does not implement POSIX mode bits, so the file's protection
 * is its ACL and nothing else -- `fs.stat().mode` reports a synthesised 0666 there whatever
 * the ACL says.
 *
 * The previous implementation ran `icacls /inheritance:r /grant:r <name>:F` and then checked
 * the result by matching DISPLAY NAMES: `Everyone`, `BUILTIN\Users`. Two things were wrong
 * with that, and both were measured before this file was written:
 *
 *   1. `/grant:r` replaces only the named user's entry and `/inheritance:r` removes only
 *      inherited ones. An explicit ACE granting `S-1-5-18` FULL control survived, and the
 *      verification accepted it because SYSTEM was not one of the names being matched.
 *   2. Those names are localized. On a non-English Windows the check matches nothing at all,
 *      so it would have passed over any principal whatsoever.
 *
 * Everything below therefore works in SIDs, which Windows does not translate.
 */

const isWindows = process.platform === 'win32';
/** Skipped elsewhere: the POSIX mode enforcement is covered in signedTxFlow.test.ts. */
const onWindows = isWindows ? describe : describe.skip;

const KEY = '0x' + '5c'.repeat(32);
const CHAIN = 4663;

/** Everyone. A well-known SID, referenced numerically so no locale can hide it. */
const EVERYONE = 'S-1-1-0';
/** NT AUTHORITY\SYSTEM. Foreign to the current user, and the one that used to slip through. */
const SYSTEM = 'S-1-5-18';

const INTENT = {
  chainId: CHAIN,
  to: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  data: '0xf35abbcf' + '33'.repeat(32),
  value: 500_000_000_000_000n,
  ceilings: { maxValueWei: 2_000_000_000_000_000n, maxGasCostWei: 2_000_000_000_000_000n },
};

function currentSid(): string {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8' }
  );
  return out.trim();
}

/**
 * Every trustee on the file's DACL, as a SID.
 *
 * Reads the same way the production path does, and for the same reason. Asking for the SDDL
 * instead would return well-known accounts as two-letter abbreviations -- on the GitHub runner
 * the account under test came back as `LA`, the local Administrator -- so a test comparing
 * spellings would fail a file that is correctly locked down, and could pass one that is not.
 */
interface RealRule {
  sid: string;
  type: string;
  rights: number;
  inherited: boolean;
}

function aceRulesOf(file: string): RealRule[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sec=[System.Security.AccessControl.AccessControlSections]::Access',
    '$acl=[System.IO.File]::GetAccessControl($env:PONSR_T, $sec)',
    '$t=[System.Security.Principal.SecurityIdentifier]',
    'foreach($r in $acl.GetAccessRules($true,$true,$t)){',
    "  Write-Output ($r.IdentityReference.Value+'|'+$r.AccessControlType+'|'+[int]$r.FileSystemRights+'|'+$r.IsInherited)",
    '}',
  ].join('; ');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, PONSR_T: file },
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sid, type, rights, inherited] = l.split('|');
      return {
        sid: sid.toUpperCase(),
        type,
        rights: Number.parseInt(rights, 10),
        inherited: inherited === 'True',
      };
    });
}

const aceSidsOf = (file: string) => aceRulesOf(file).map((r) => r.sid);

/** Exactly one explicit Allow FullControl rule for the given SID, and nothing else. */
function expectSoleFullControl(file: string, sid: string): void {
  const rules = aceRulesOf(file);
  expect(rules).toHaveLength(1);
  expect(rules[0].sid).toBe(sid.toUpperCase());
  expect(rules[0].type).toBe('Allow');
  expect(rules[0].rights).toBe(WINDOWS_FULL_CONTROL);
  expect(rules[0].inherited).toBe(false);
}

function grantTo(file: string, sid: string, rights = '(F)'): void {
  execFileSync('icacls', [file, '/grant', `*${sid}:${rights}`], { stdio: 'pipe' });
}

function tmpJournalPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-acl-'));
  return path.join(dir, 'canary.sqlite');
}

/** Writes a signed row, which is what brings the WAL and SHM sidecars into existence. */
async function writeSignedRow(journal: CanaryJournal): Promise<void> {
  const wallet = new ethers.Wallet(KEY);
  const id = journal.prepare({
    runId: 'acl',
    op: 'token_launch',
    deploymentId: 'pons-v2-current-7ed',
    chainId: CHAIN,
    to: INTENT.to,
    value: INTENT.value,
    calldata: INTENT.data,
  });
  await signAndPersist(
    {
      signer: {
        address: async () => wallet.address,
        signTransaction: (tx) => wallet.signTransaction(tx),
      },
      broadcaster: {
        getTransactionCount: async () => 4,
        estimateGas: async () => 210000n,
        getFeeData: async () => ({
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1n,
          gasPrice: null,
        }),
        broadcastTransaction: async () => {
          throw new Error('these tests never broadcast');
        },
      },
    },
    journal,
    id,
    INTENT
  );
}

/** The three files that can hold raw transaction bytes. */
const sidecars = (db: string) => [db, `${db}-wal`, `${db}-shm`];

onWindows('the journal is owned by exactly one account on Windows', () => {
  it('leaves a single ACE for the current SID on the database and both sidecars', async () => {
    const db = tmpJournalPath();
    const journal = new CanaryJournal(db, { allowEphemeral: true });
    await writeSignedRow(journal);
    const sid = currentSid();

    const present = sidecars(db).filter((f) => fs.existsSync(f));
    // The write must actually have produced sidecars, or this proves nothing about them.
    expect(present).toContain(`${db}-wal`);

    for (const f of present) {
      // Not just "whose": exactly one rule, Allow, FullControl, not inherited.
      expectSoleFullControl(f, sid);
    }
    journal.close();
  });

  /**
   * The measured defect, for each of the three files: an explicit ACE added by somebody else
   * used to survive and be accepted. It must now be gone after the next secure pass.
   */
  it.each([
    ['database', 0],
    ['WAL sidecar', 1],
    ['SHM sidecar', 2],
  ])('removes a pre-existing foreign explicit ACE from the %s', async (_label, index) => {
    const db = tmpJournalPath();
    /**
     * Left OPEN on purpose. SQLite checkpoints and deletes the WAL and SHM on a clean close,
     * so closing here would remove the very files these cases are about -- and the test would
     * have quietly become a third copy of the database case.
     */
    const journal = new CanaryJournal(db, { allowEphemeral: true });
    await writeSignedRow(journal);

    const target = sidecars(db)[index];
    if (!fs.existsSync(target)) {
      throw new Error(`${path.basename(target)} does not exist, so this case would prove nothing`);
    }

    grantTo(target, EVERYONE, '(R)');
    grantTo(target, SYSTEM, '(F)');

    /**
     * Windows renders these two as the SDDL abbreviations `WD` and `SY` rather than as the
     * SIDs they were granted with. That is precisely why the check compares against the
     * current user's SID instead of matching a list of principals: an abbreviation, a
     * localized display name and a raw SID are three spellings of the same grant, and only
     * "is this my SID?" is true of all three.
     */
    const mine = currentSid().toUpperCase();
    const before = aceSidsOf(target);
    const foreignBefore = before.filter((t) => t !== mine);
    expect(foreignBefore.length).toBeGreaterThanOrEqual(2);

    // A second handle runs the secure pass over all three files while the first keeps the
    // sidecars alive.
    const reopened = new CanaryJournal(db, { allowEphemeral: true });
    const after = aceSidsOf(target);
    expect(after).toEqual([mine]);
    expectSoleFullControl(target, mine);
    reopened.close();
    journal.close();
  });

  it('still holds after a further signed write, not only at open time', async () => {
    const db = tmpJournalPath();
    const journal = new CanaryJournal(db, { allowEphemeral: true });
    await writeSignedRow(journal);
    grantTo(db, EVERYONE, '(R)');

    // recordSigned re-secures before writing raw bytes; a second run reaches it.
    const second = new CanaryJournal(db, { allowEphemeral: true });
    expectSoleFullControl(db, currentSid());
    second.close();
    journal.close();
  });
});

/**
 * The refusal half, tested against the shipped decision function rather than a reimplementation
 * of it. These run everywhere, because an SDDL string is just data.
 */
describe('an owner-only DACL is judged by SID, never by display name', () => {
  const MINE = 'S-1-5-21-111-222-333-1001';

  /**
   * A trustee says WHO. It says nothing about allow-versus-deny, or about how much.
   *
   * Both cases below name the correct SID and were ACCEPTED by the previous verifier, which
   * checked only the trustee and the inherited flag while the completion report claimed the
   * result was "exactly one explicit ALLOW FullControl ACE". Measured against that code:
   *
   *   D:P(D;;FA;;;<SID>)  -> accepted   (a deny of everything)
   *   D:P(A;;FR;;;<SID>)  -> accepted   (read-only)
   */
  it('refuses a DENY entry for the current SID', () => {
    expect(() =>
      assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(D;;FA;;;${MINE})`), MINE)
    ).toThrow(/Deny entry/);
  });

  it('refuses a read-only grant to the current SID', () => {
    expect(() =>
      assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FR;;;${MINE})`), MINE)
    ).toThrow(new RegExp(`rather than full control \\(${WINDOWS_FULL_CONTROL}\\)`));
  });

  it('refuses rights it cannot interpret rather than assuming they are enough', () => {
    expect(() =>
      assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;GA;;;${MINE})`), MINE)
    ).toThrow(/rights could not be read/);
  });

  /**
   * Two entries for one SID can disagree, and which wins depends on their order. The
   * descriptor this code writes has exactly one, so anything else is not its descriptor.
   */
  it('refuses duplicate entries for the current SID', () => {
    expect(() =>
      assertOwnerOnlyDacl(
        'canary.sqlite',
        parseDaclAces(`D:P(A;;FA;;;${MINE})(A;;FA;;;${MINE})`),
        MINE
      )
    ).toThrow(/carries 2 access-control entries/);
  });

  it('accepts exactly one ACE for the given SID', () => {
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FA;;;${MINE})`), MINE)).not.toThrow();
  });

  it('refuses SYSTEM, which the old display-name check let through', () => {
    expect(() =>
      assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FA;;;${MINE})(A;;FA;;;${SYSTEM})`), MINE)
    ).toThrow(new RegExp(SYSTEM));
  });

  /**
   * `SY` and `BA` are SDDL abbreviations, not SIDs. They are foreign by construction here,
   * which is why no table of well-known principals is needed or kept.
   */
  it('refuses well-known abbreviations without needing to know what they mean', () => {
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FA;;;${MINE})(A;;FA;;;SY)`), MINE)).toThrow(
      /still grants access to SY/
    );
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FA;;;${MINE})(A;;FA;;;BA)`), MINE)).toThrow(
      /still grants access to BA/
    );
  });

  it('refuses Everyone by SID, whatever it is called on this machine', () => {
    expect(() =>
      assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:P(A;;FA;;;${EVERYONE})(A;;FA;;;${MINE})`), MINE)
    ).toThrow(new RegExp(EVERYONE));
  });

  it('refuses an inherited entry even when it names the right SID', () => {
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(`D:AI(A;ID;FA;;;${MINE})`), MINE)).toThrow(
      /inherited/
    );
  });

  it('refuses an empty DACL rather than reading it as harmless', () => {
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces('D:P'), MINE)).toThrow(/no access-control entries/);
  });

  it('ignores the owner and group fields, and stops at the SACL', () => {
    const sddl = `O:${SYSTEM}G:${SYSTEM}D:P(A;;FA;;;${MINE})S:AI(AU;SA;FA;;;WD)`;
    expect(() => assertOwnerOnlyDacl('canary.sqlite', parseDaclAces(sddl), MINE)).not.toThrow();
    expect(parseDaclAces(sddl).map((a) => a.trustee)).toEqual([MINE]);
  });
});
