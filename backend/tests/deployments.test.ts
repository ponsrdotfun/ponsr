import {
  DEPLOYMENTS,
  executableDeployment,
  deploymentById,
  indexableDeployments,
} from '../src/deployments';

/**
 * Which pons deployment a launch goes to, and which ones only exist to be read.
 *
 * Ponsr spent a week reporting "the launchpad is closed" while reading
 * 0x7E1EAbd5…, a superseded V2 whose launchEnabled really is false. The current V2 at
 * 0x7eD598…EC7e has been open the whole time. One mutable factory address made those
 * two indistinguishable, so this registry makes each deployment a named thing with
 * its own ABI, escrow, selector and schema -- and exactly one of them executable.
 */
describe('deployment registry', () => {
  it('has exactly one executable deployment, and it is current V2', () => {
    const exec = executableDeployment();
    expect(exec.factory.toLowerCase()).toBe('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
    expect(DEPLOYMENTS.filter((d) => d.executable)).toHaveLength(1);
  });

  // The old one must stay readable: it carries real launches that the board shows.
  it('keeps legacy deployments indexable but never executable', () => {
    const legacy = deploymentById('pons-v2-legacy-7e1');
    expect(legacy.executable).toBe(false);
    expect(legacy.factory.toLowerCase()).toBe('0x7e1eabd52ae29598e6483f72dcf1a70b14284db8');
    expect(indexableDeployments().map((d) => d.id)).toEqual(
      expect.arrayContaining(['pons-v1', 'pons-v2-legacy-7e1', 'pons-v2-current-7ed'])
    );
  });

  // Every field here is something that, if wrong, produces a reverted transaction or
  // stranded fees rather than an error message.
  it('binds the identity of the current deployment', () => {
    const d = executableDeployment();
    expect(d.chainId).toBe(4663);
    expect(d.feeEscrow.toLowerCase()).toBe('0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e');
    expect(d.launchDeployer!.toLowerCase()).toBe('0x3711cea4feade896c913c68f01eda97cb06d1a42');
    expect(d.launchForwarder!.toLowerCase()).toBe('0xe33e9e479df8802cb0866d5d05258bec4cf62948');
    expect(d.launchSelector).toBe('0xf35abbcf');
    expect(d.tokenParamsVersion).toBe('v2-salt');
    expect(d.runtimeBytecodeLength).toBe(24177);
    expect(d.runtimeBytecodeSha256).toBe(
      '226a042e6d68a69a6038d4fda211925b03eb5299399434b87a7877f79f6e3848'
    );
    expect(d.abiSha256).toBe('1d424e7b711cdd4d23c08ba2ccc12bc2f478e5dc794e8cdc6bd3fd35fa85b323');
  });

  // The legacy deployment must not quietly inherit the current selector: that is the
  // exact confusion that would send salt-bearing calldata to a factory that reverts.
  it('gives the legacy V2 its own, different selector and schema', () => {
    const legacy = deploymentById('pons-v2-legacy-7e1');
    expect(legacy.launchSelector).toBe('0xa41d5f2b');
    expect(legacy.tokenParamsVersion).toBe('v2-no-salt');
    expect(legacy.feeEscrow.toLowerCase()).toBe('0xbc39b6502e1a6ab36e4a5c5026a35f08342a0a9c');
  });

  it('refuses an unknown deployment id rather than returning a default', () => {
    expect(() => deploymentById('pons-v9')).toThrow(/unknown deployment/i);
  });
});
