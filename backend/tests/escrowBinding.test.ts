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
