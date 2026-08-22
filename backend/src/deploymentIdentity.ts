import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { PonsDeployment } from './deployments';

/**
 * Checks that the contract on the chain is the one the registry describes.
 *
 * WHY THIS IS NOT PARANOIA
 * ------------------------
 * The registry already recorded an ABI hash, a runtime bytecode hash and a launch
 * selector for each deployment. Nothing read them. They were accurate, checked in, and
 * inert -- and the launch path went on resolving a factory by address alone.
 *
 * That is precisely the failure this whole migration is a response to. Ponsr spent a
 * week reading `0x7E1EAbd5…`: an address that resolved, answered calls, and returned
 * confident, correct answers about a contract nobody launches through any more. An
 * address that resolves looks exactly like an address that is right. The hashes are the
 * only part of the manifest that can tell those apart, so something has to ask them.
 *
 * WHAT IS CHECKED, AND WHERE THE TRUTH COMES FROM
 * -----------------------------------------------
 *   runtime length/sha256   the chain, via getCode -- catches an upgrade, a
 *                           redeployment, a wrong address, or the wrong chain entirely
 *   fee escrow              the chain, via feeEscrow() -- the mismatch with no recovery
 *   abi sha256              the file on disk -- catches a regenerated or edited ABI
 *   launch selector         derived FROM that ABI -- catches a manifest that claims a
 *                           selector the ABI does not actually produce
 *
 * The last one is worth stating plainly: comparing the manifest's selector string to
 * itself would prove nothing. It is recomputed from the signature against the loaded
 * ABI, so a drifting ABI and a stale selector cannot agree with each other by accident.
 *
 * Every axis is reported, not just the first to fail. A guard that stops at the first
 * mismatch tells an operator to fix one thing and then surprises them with the next.
 */

export interface IdentityCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface IdentityResult {
  deploymentId: string;
  ok: boolean;
  checks: IdentityCheck[];
  /** Human-readable, one per drifted axis, each naming the axis. */
  mismatches: string[];
}

function record(checks: IdentityCheck[], name: string, expected: string, actual: string): void {
  checks.push({ name, expected, actual, ok: expected.toLowerCase() === actual.toLowerCase() });
}

/**
 * The ABI array itself, whatever the file wraps it in.
 *
 * `ponsLaunchFactory.json` is an object carrying provenance -- `_source`, `_note`,
 * `contractName`, `isVerified` -- with the array under `abi`. The v2 files are bare
 * arrays. Hashing the wrapper for one and the array for the other reported drift on a
 * file nobody had touched, which is the most expensive kind of false alarm: it teaches
 * the reader that this guard is noise.
 */
function abiArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const inner = (parsed as Record<string, unknown>).abi;
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

/** Canonical ABI hash: stable under formatting, so re-indenting a file is not drift. */
export function canonicalAbiSha256(abi: unknown): string {
  return ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(abiArray(abi) ?? abi))).slice(2);
}

export async function verifyDeploymentIdentity(
  deployment: PonsDeployment,
  provider: ethers.Provider
): Promise<IdentityResult> {
  const checks: IdentityCheck[] = [];

  // --- which chain are we even on? -------------------------------------------------
  //
  // First, because it is the cheapest axis and the one most often wrong in practice.
  // Every other check reads an address, and the same address on a different chain is a
  // different contract -- usually no contract at all. `backend/.env` points at testnet
  // by design while the executable deployment is a mainnet contract, so this is a
  // routine misconfiguration, not a hypothetical.
  //
  // Without it the guard still fails, but it fails by reporting the runtime hash as
  // e3b0c442... -- the sha256 of nothing -- which reads as "the bytecode differs" and
  // sends the reader hunting an upgrade that never happened.
  //
  // A provider that cannot say which chain it is on has not proven it is the right one,
  // so an unreadable network is a mismatch rather than a pass.
  let chainId = 'unreadable';
  try {
    chainId = String((await provider.getNetwork()).chainId);
  } catch (err: any) {
    chainId = `unreadable (${String(err?.message ?? err).slice(0, 40)})`;
  }
  record(checks, 'chain id', String(deployment.chainId), chainId);

  // --- the chain -----------------------------------------------------------------
  const code = await provider.getCode(deployment.factory);
  if (!code || code === '0x') {
    // Distinguished from a hash mismatch on purpose. "No contract here" and "a
    // different contract is here" send an operator to entirely different places: the
    // first is usually a wrong chain or a typo, the second is a real upgrade.
    checks.push({
      name: 'runtime bytecode',
      expected: `${deployment.runtimeBytecodeLength} bytes`,
      actual: 'no contract at this address (empty account)',
      ok: false,
    });
  } else {
    record(checks, 'runtime length', String(deployment.runtimeBytecodeLength), String((code.length - 2) / 2));
    record(checks, 'runtime sha256', deployment.runtimeBytecodeSha256, ethers.sha256(code).slice(2));
  }

  // Only where an escrow is the fee model. v1 pushes from the locker and exposes no
  // `feeEscrow()` at all, so calling it reverts -- and reading that revert as drift
  // condemns a contract for lacking a function it was never meant to have. The
  // exemption is a declared property of the deployment, not a softened check: anything
  // that credits an escrow is still held to the address matching exactly, because that
  // is the mismatch with no recovery.
  if (deployment.feeModel === 'escrow-credit') {
    let liveEscrow = 'unreadable';
    try {
      const factory = new ethers.Contract(
        deployment.factory,
        ['function feeEscrow() view returns (address)'],
        provider
      );
      liveEscrow = String(await factory.feeEscrow());
    } catch (err: any) {
      liveEscrow = `unreadable (${String(err?.message ?? err).slice(0, 40)})`;
    }
    record(checks, 'fee escrow', deployment.feeEscrow, liveEscrow);
  } else {
    checks.push({
      name: 'fee escrow',
      expected: `${deployment.feeEscrow} (locker, pushed)`,
      actual: 'not applicable: this deployment pushes fees rather than escrowing them',
      ok: true,
    });
  }

  // --- the files the code will actually load --------------------------------------
  let abi: unknown = null;
  try {
    abi = JSON.parse(fs.readFileSync(path.join(__dirname, deployment.abiPath), 'utf8'));
    record(checks, 'abi sha256', deployment.abiSha256, canonicalAbiSha256(abi));
  } catch (err: any) {
    checks.push({
      name: 'abi sha256',
      expected: deployment.abiSha256,
      actual: `unreadable: ${String(err?.message ?? err).slice(0, 60)}`,
      ok: false,
    });
  }

  const fragments = abiArray(abi);
  if (fragments) {
    try {
      const iface = new ethers.Interface(fragments as ethers.InterfaceAbi);
      const fragment = iface.getFunction(deployment.launchSignature);
      record(checks, 'launch selector', deployment.launchSelector, fragment ? fragment.selector : 'not in ABI');
    } catch (err: any) {
      checks.push({
        name: 'launch selector',
        expected: deployment.launchSelector,
        actual: `signature not found: ${deployment.launchSignature}`,
        ok: false,
      });
    }
  }

  const mismatches = checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: expected ${c.expected}, chain/file says ${c.actual}`);

  return { deploymentId: deployment.id, ok: mismatches.length === 0, checks, mismatches };
}

/**
 * The same check, in the form the launch path needs: it either returns or it stops.
 *
 * Deliberately throwing rather than returning a flag. This runs before a splitter is
 * deployed and before a fee is spent, and a boolean at that point is something a caller
 * can forget to read.
 */
export async function assertDeploymentIdentity(
  deployment: PonsDeployment,
  provider: ethers.Provider
): Promise<void> {
  const result = await verifyDeploymentIdentity(deployment, provider);
  if (!result.ok) {
    throw new Error(
      `${deployment.id} (${deployment.factory}) is not the contract the registry describes. ` +
        `Nothing was deployed and no fee was spent.\n  ` +
        result.mismatches.join('\n  ')
    );
  }
}
