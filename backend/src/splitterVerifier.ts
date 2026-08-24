import { ethers } from 'ethers';
import { PonsDeployment } from './deployments';
import { splitterArtifactFor } from './splitterDeployer';

/**
 * One verifier for a deployed splitter, shared by the direct path and by recovery.
 *
 * Two things went wrong that this exists to prevent.
 *
 * ORDER. The direct path marked the journal row `confirmed` from the receipt alone --
 * status 1 plus a contract address -- and only afterwards read the deployed code. A stale
 * or wrong splitter was therefore persisted as terminal before anything checked what it
 * was, and if the later check failed and exited, `unresolved()` was clean and a rerun could
 * proceed past a permanent invalid contract. That is the 2026-08-04 wrong-splitter loss
 * again, wearing a green journal.
 *
 * DRIFT. Recovery grew its own selector check while the script kept a different one
 * inline. Two verifiers for one question disagree eventually, and the disagreement surfaces
 * on the day somebody is relying on them.
 *
 * WHY SELECTOR PRESENCE IS NOT ENOUGH
 * -----------------------------------
 * A four-byte string can appear inside unrelated bytecode by coincidence or by
 * construction. The strong check is the compiled artifact's own runtime bytecode, which is
 * what `compile-all.js` produces and what the deployment registry pins. Selector presence
 * is kept as a secondary signal because it produces the clearer message when a stale build
 * is the actual cause -- which it has been, once, expensively.
 */

export interface SplitterEvidence {
  /** Receipt status. null means no receipt was seen, which is not a failure to verify. */
  receiptStatus: number | null;
  contractAddress: string | null;
  /** Deployed runtime bytecode at that address. */
  deployedCode: string;
  deployment: PonsDeployment;
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

/** Runtime bytecode as the compiler produced it, for exact comparison. */
function expectedRuntime(deployment: PonsDeployment): string | null {
  try {
    const artifact = splitterArtifactFor(deployment) as { deployedBytecode?: string; runtimeBytecode?: string };
    const raw = artifact.deployedBytecode ?? artifact.runtimeBytecode;
    return typeof raw === 'string' && raw.length > 2 ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
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

  const code = withoutMetadata(evidence.deployedCode);
  if (code.length === 0) {
    return {
      ok: false,
      problems: [`there is no code at ${evidence.contractAddress}: the address holds an empty account`],
    };
  }

  // Primary: the compiled artifact's own runtime, metadata aside.
  const expected = expectedRuntime(evidence.deployment);
  if (expected) {
    if (withoutMetadata(expected) !== code) {
      problems.push(
        `deployed runtime at ${evidence.contractAddress} does not match the artifact for ` +
          `${evidence.deployment.id}. A splitter that is not the compiled one may take fees it cannot pay out.`
      );
    }
  } else {
    problems.push(
      `no runtime bytecode is recorded for ${evidence.deployment.id}, so the deployed contract ` +
        'can only be checked by interface. Treat this as weaker evidence, not as a pass.'
    );
  }

  // Secondary: the interface, which names the actual consequence when a stale build is the cause.
  for (const { sig, why } of requiredSelectors(evidence.deployment)) {
    const selector = ethers.id(sig).slice(2, 10);
    if (!code.includes(selector)) problems.push(`deployed code has no ${sig} — ${why}`);
  }

  return problems.length === 0
    ? { ok: true, problems: [], splitterAddress: evidence.contractAddress }
    : { ok: false, problems };
}
