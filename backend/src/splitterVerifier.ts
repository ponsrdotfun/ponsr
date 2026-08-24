import { ethers } from 'ethers';
import { PonsDeployment } from './deployments';
import { splitterArtifactFor } from './splitterDeployer';

/**
 * One verifier for a deployed splitter, shared by the direct path and by recovery.
 *
 * WHY A PLAIN BYTE COMPARISON CANNOT WORK
 * ---------------------------------------
 * `creator`, `treasury`, `token` and `escrow` are Solidity immutables. The compiler emits
 * `deployedBytecode` with ZEROS at their reference offsets, and the constructor patches
 * the real values in as the contract is created. So `eth_getCode` on a perfectly correct
 * splitter never equals the artifact template: measured here, 14 runs of 20 bytes across
 * the four addresses.
 *
 * The first version of this file compared the two directly and would have rejected every
 * real deployment. Worse, the test that covered it passed the artifact template AS the
 * deployed code, so it could not possibly have caught that -- the fixture WAS the expected
 * value. The operational consequence would have been the first authorised canary spending
 * gas on a splitter, having it refused, and wedging: recovery calls the same verifier.
 *
 * WHY THE OFFSETS ARE NOT SIMPLY IGNORED
 * --------------------------------------
 * Masking them would make the comparison pass for a splitter carrying an attacker's
 * recipients or a foreign escrow -- the exact bytes that decide where money goes. So every
 * non-immutable byte must match the artifact exactly, AND every immutable slot must equal
 * the value it was supposed to be constructed with. The bytes are then confirmed a second
 * time by reading the contract's own public getters, which is independent evidence rather
 * than a second look at the same string.
 */

export interface SplitterBindings {
  creator: string;
  treasury: string;
  token: string;
  escrow?: string;
}

export interface SplitterEvidence {
  /** Receipt status. null means no receipt was seen, which is not a failure to verify. */
  receiptStatus: number | null;
  contractAddress: string | null;
  /** Deployed runtime bytecode at that address. */
  deployedCode: string;
  deployment: PonsDeployment;
  /** What construction was supposed to bind. */
  expectedCreator: string;
  expectedTreasury: string;
  expectedTokenPlaceholder: string;
  expectedEscrow: string;
  /** The contract's own view of its bindings, read independently of the bytes. */
  bindings?: SplitterBindings | null;
  /**
   * Whether getter evidence is mandatory.
   *
   * True on every authority-bearing path -- the direct canary and operator recovery. It
   * was optional, and optional meant a null read produced no problem at all, so a splitter
   * whose getters could not be reached was verified on bytes alone while the report claimed
   * two independent lines of evidence. An optional default that silently weakens an
   * authority path is worse than no default.
   *
   * Left false for the pure unit tests that have no chain to read from, which is the only
   * legitimate reason to omit it.
   */
  requireBindings?: boolean;
}

export interface SplitterVerdict {
  ok: boolean;
  problems: string[];
  /** Present only on a green verdict. Nothing else may be treated as the splitter. */
  splitterAddress?: string;
}

/** Interface the launch path depends on. v1 has no escrow claim, so it needs only the split. */
function requiredSelectors(deployment: PonsDeployment): Array<{ sig: string; why: string }> {
  const split = {
    sig: 'splitERC20(address)',
    why: 'that is the ETH-only version: it can receive pons fees and never pay them out',
  };
  if (deployment.tokenParamsVersion === 'v1') return [split];
  return [
    split,
    {
      sig: 'claimAndSplit(address)',
      why:
        'that is the v1 splitter. On v2 fees are credited to pons’s escrow and paid to ' +
        'msg.sender, so this contract would be credited fees no transaction could ever move',
    },
  ];
}

interface Artifact {
  deployedBytecode?: string;
  immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
  immutableNames?: Record<string, string>;
}

/**
 * Strips the CBOR metadata solc appends to deployed bytecode.
 *
 * The trailing bytes hash the source, so identical logic compiled from a path or line
 * ending that differs by a byte produces a different tail. Comparing whole strings would
 * report a correct splitter as wrong, which is the failure mode that gets a real check
 * deleted for being noisy.
 */
function withoutMetadata(code: string): string {
  const c = code.toLowerCase().replace(/^0x/, '');
  if (c.length < 4) return c;
  const declared = parseInt(c.slice(-4), 16);
  const cut = c.length - 4 - declared * 2;
  return cut > 0 ? c.slice(0, cut) : c;
}

/** A 32-byte word holding a right-aligned address, as the constructor writes it. */
function addressWord(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32).slice(2).toLowerCase();
}

export function verifyDeployedSplitter(evidence: SplitterEvidence): SplitterVerdict {
  const problems: string[] = [];

  if (evidence.receiptStatus === null) {
    return {
      ok: false,
      problems: [
        'no receipt was seen for the splitter deployment, so nothing establishes whether a ' +
          'contract was created. This is ambiguous, not failed: do not deploy another.',
      ],
    };
  }
  if (evidence.receiptStatus !== 1) {
    return { ok: false, problems: [`the splitter deployment receipt reports status ${evidence.receiptStatus}`] };
  }
  if (!evidence.contractAddress) {
    return { ok: false, problems: ['the receipt carries no contract address, so nothing proves what was created'] };
  }

  const actual = withoutMetadata(evidence.deployedCode);
  if (actual.length === 0) {
    return {
      ok: false,
      problems: [`there is no code at ${evidence.contractAddress}: the address holds an empty account`],
    };
  }

  const artifact = splitterArtifactFor(evidence.deployment) as Artifact;
  const template = artifact.deployedBytecode ? withoutMetadata(artifact.deployedBytecode) : null;
  const refs = artifact.immutableReferences;
  const names = artifact.immutableNames;

  // Fail closed. Without the offsets there is no way to tell a constructor-patched byte
  // from a tampered one, and guessing in either direction is worse than refusing.
  if (!template || !refs || !names) {
    return {
      ok: false,
      problems: [
        `the artifact for ${evidence.deployment.id} carries no runtime bytecode or immutable ` +
          'references, so a deployed contract cannot be verified exactly. Run `node compile-all.js`.',
      ],
    };
  }

  if (actual.length !== template.length) {
    return {
      ok: false,
      problems: [
        `deployed runtime at ${evidence.contractAddress} is ${actual.length / 2} bytes; the ` +
          `${evidence.deployment.id} artifact is ${template.length / 2}. Different code entirely.`,
      ],
    };
  }

  const wanted: Record<string, string> = {
    creator: evidence.expectedCreator,
    treasury: evidence.expectedTreasury,
    token: evidence.expectedTokenPlaceholder,
    escrow: evidence.expectedEscrow,
  };

  // Every immutable slot must hold the value it was supposed to be constructed with.
  const immutableSpans: Array<[number, number]> = [];
  for (const [id, sites] of Object.entries(refs)) {
    const name = names[id];
    const expectedAddr = name ? wanted[name] : undefined;
    for (const site of sites) {
      const from = site.start * 2;
      const to = from + site.length * 2;
      immutableSpans.push([from, to]);
      if (!name || expectedAddr === undefined) {
        problems.push(`immutable reference id ${id} at byte ${site.start} has no known name to bind`);
        continue;
      }
      const found = actual.slice(from, to);
      if (found !== addressWord(expectedAddr)) {
        problems.push(
          `immutable \`${name}\` at byte ${site.start} is 0x${found.slice(24)}, expected ` +
            `${ethers.getAddress(expectedAddr)}. That is where this splitter sends money.`
        );
      }
    }
  }

  // Every byte outside those spans must match the compiled artifact exactly.
  const inImmutable = new Array(actual.length).fill(false);
  for (const [from, to] of immutableSpans) for (let i = from; i < to; i += 1) inImmutable[i] = true;
  let firstDiff = -1;
  for (let i = 0; i < actual.length; i += 1) {
    if (!inImmutable[i] && actual[i] !== template[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff >= 0) {
    problems.push(
      `deployed runtime differs from the ${evidence.deployment.id} artifact at byte ` +
        `${Math.floor(firstDiff / 2)}, outside any immutable. The logic is not the compiled logic.`
    );
  }

  // Interface, as a secondary signal that names the likely cause when a stale build is it.
  for (const { sig, why } of requiredSelectors(evidence.deployment)) {
    const selector = ethers.id(sig).slice(2, 10);
    if (!actual.includes(selector)) problems.push(`deployed code has no ${sig} — ${why}`);
  }

  /**
   * The contract's own answer, which is evidence of a different kind.
   *
   * Reading the getters tests the same facts through the EVM rather than through a string
   * this process assembled. Optional because a caller may have no provider, and its
   * absence is reported rather than treated as agreement.
   */
  if (evidence.requireBindings && !evidence.bindings) {
    // Unavailable is not agreement. A getter that could not be read has told us nothing,
    // and treating silence as confirmation is how a check stops being one.
    problems.push(
      `the splitter's own creator/treasury/token${
        evidence.deployment.feeModel === 'escrow-credit' ? '/escrow' : ''
      } getters could not be read at ${evidence.contractAddress}. Byte evidence alone is not ` +
        'sufficient on this path: the contract has to agree about where it sends money.'
    );
  }

  if (evidence.bindings) {
    const b = evidence.bindings;
    const same = (a: string | undefined, e: string) =>
      typeof a === 'string' && a.toLowerCase() === e.toLowerCase();
    if (!same(b.creator, evidence.expectedCreator)) problems.push(`creator() reports ${b.creator}, expected ${evidence.expectedCreator}`);
    if (!same(b.treasury, evidence.expectedTreasury)) problems.push(`treasury() reports ${b.treasury}, expected ${evidence.expectedTreasury}`);
    if (!same(b.token, evidence.expectedTokenPlaceholder)) problems.push(`token() reports ${b.token}, expected ${evidence.expectedTokenPlaceholder}`);
    if (evidence.deployment.feeModel === 'escrow-credit') {
      if (!same(b.escrow ?? '', evidence.expectedEscrow)) problems.push(`escrow() reports ${b.escrow}, expected ${evidence.expectedEscrow}`);
    }
  }

  return problems.length === 0
    ? { ok: true, problems: [], splitterAddress: evidence.contractAddress }
    : { ok: false, problems };
}
