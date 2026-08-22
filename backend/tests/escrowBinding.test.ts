import { assertEscrowMatches, splitterEscrowFor } from '../src/splitterDeployer';
import { deploymentById, executableDeployment } from '../src/deployments';

/**
 * The escrow a splitter is built against is immutable, escrow claims pay `msg.sender`,
 * and there is no `claimFor`. So a splitter bound to the wrong escrow holds a
 * creator's fees somewhere nothing can ever reach them -- not the treasury, not the
 * creator, not pons. Money that is visible, attributed, and gone.
 *
 * The two V2 deployments use different escrows, which makes this the single most
 * dangerous thing about the migration.
 */
describe('splitter escrow binding', () => {
  const current = executableDeployment();
  const legacy = deploymentById('pons-v2-legacy-7e1');

  it('uses the executable deployment’s escrow', () => {
    expect(splitterEscrowFor(current).toLowerCase()).toBe(
      '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'
    );
  });

  // The check that has to happen before gas is spent: the manifest is a claim about
  // the chain, and the chain is the authority.
  it('passes when the live factory agrees with the manifest', () => {
    expect(() => assertEscrowMatches(current, current.feeEscrow)).not.toThrow();
  });

  it('accepts a differently-cased address as the same address', () => {
    expect(() => assertEscrowMatches(current, current.feeEscrow.toUpperCase().replace('0X', '0x'))).not.toThrow();
  });

  // The exact mistake this migration could make: the old escrow, silently.
  it('refuses the superseded escrow outright', () => {
    expect(() => assertEscrowMatches(current, legacy.feeEscrow)).toThrow(/escrow/i);
  });

  it('names both addresses when it refuses, so the mismatch is actionable', () => {
    try {
      assertEscrowMatches(current, legacy.feeEscrow);
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.message).toContain(current.feeEscrow);
      expect(e.message).toContain(legacy.feeEscrow);
    }
  });

  it('refuses a zero escrow rather than deploying an unusable splitter', () => {
    expect(() => assertEscrowMatches(current, '0x' + '00'.repeat(20))).toThrow(/escrow/i);
  });
});

/**
 * The deployer itself, not just the guard beside it.
 *
 * Found during the independent review pass of this migration: `deploySplitter` still
 * read the escrow from configuration, whose default is the SUPERSEDED one. Everything
 * else had been migrated -- the registry, the encoder, the target's pre-build check --
 * and the launch would have succeeded, because the factory's escrow matched the
 * registry. Only the splitter was bound to the wrong one, and that is the failure
 * mode with no recovery: fees credited to an address the splitter cannot claim from.
 *
 * The fork rehearsal did not catch it because it constructed the splitter itself.
 */
describe('the splitter deployer binds the registry escrow', () => {
  it('does not read the escrow from configuration', () => {
    const raw = require('fs').readFileSync(
      require('path').join(__dirname, '../src/splitterDeployer.ts'),
      'utf8'
    );
    // Comments are stripped first. The file deliberately explains what it used to read
    // and why that was dangerous, and a check that could not tell an explanation from
    // an instruction would force the explanation out -- which is how the reason for a
    // guard gets lost while the guard survives.
    const code: string = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l: string) => !l.trim().startsWith('//'))
      .join('\n');

    // Configuration and the registry can disagree, and only one of them is checked
    // against the chain before a launch.
    expect(code).not.toMatch(/PONS_V2_FEE_ESCROW_ADDRESS/);
    expect(code).toMatch(/splitterEscrowFor\(/);
  });
});

/**
 * Identity, checked before the splitter is deployed.
 *
 * Order matters and this is the expensive end of it. `readCurrentReadiness` verifies
 * identity, but readiness and the deploy are two moments, and only one of them spends
 * gas. Everything between them -- a factory upgraded, an RPC swapped to another chain, a
 * regenerated ABI -- lands in that window, and the splitter is the first durable,
 * irreversible artifact the flow creates.
 *
 * A splitter deployed against a factory that has since changed is not a wasted fee; it
 * is a contract that may be handed a creator's fees and be unable to claim them. §3 of
 * the closure order requires the identity check here for that reason: a mismatch must
 * leave zero durable side effects, and after `deploySplitter` returns there is already
 * one.
 */
describe('splitter deployment refuses a drifted deployment', () => {
  const { ethers } = require('ethers');
  const { assertDeploymentIdentity } = require('../src/deploymentIdentity');

  function providerFor(over: { chainId?: number; code?: string; escrow?: string } = {}) {
    const d = executableDeployment();
    return {
      getNetwork: async () => ({ chainId: BigInt(over.chainId ?? d.chainId), name: 'x' }),
      getCode: async () => over.code ?? '0x' + 'ab'.repeat(10),
      call: async () =>
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [over.escrow ?? d.feeEscrow]),
    } as any;
  }

  function manifest(code: string, over: any = {}) {
    const d = executableDeployment();
    return {
      ...d,
      runtimeBytecodeLength: (code.length - 2) / 2,
      runtimeBytecodeSha256: ethers.sha256(code).slice(2),
      ...over,
    };
  }

  it('refuses before deploying when the chain is wrong', async () => {
    const code = '0x' + 'ab'.repeat(10);
    await expect(
      assertDeploymentIdentity(manifest(code), providerFor({ chainId: 46630, code }))
    ).rejects.toThrow(/chain id/i);
  });

  it('refuses before deploying when the escrow moved', async () => {
    const code = '0x' + 'ab'.repeat(10);
    const legacy = deploymentById('pons-v2-legacy-7e1');
    await expect(
      assertDeploymentIdentity(manifest(code), providerFor({ code, escrow: legacy.feeEscrow }))
    ).rejects.toThrow(/escrow/i);
  });

  it('says nothing was deployed and no fee was spent', async () => {
    const code = '0x' + 'ab'.repeat(10);
    await expect(
      assertDeploymentIdentity(manifest(code), providerFor({ chainId: 1, code }))
    ).rejects.toThrow(/nothing was deployed and no fee was spent/i);
  });

  // The wiring itself: the deployer must actually call the guard, not merely have one
  // available in the module next door.
  it('deploySplitter performs the check rather than trusting an earlier one', () => {
    const raw: string = require('fs').readFileSync(
      require('path').join(__dirname, '../src/splitterDeployer.ts'),
      'utf8'
    );
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l: string) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).toMatch(/assertDeploymentIdentity\(/);
  });
});
