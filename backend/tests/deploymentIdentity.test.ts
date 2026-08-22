import { ethers } from 'ethers';
import { executableDeployment, deploymentById, PonsDeployment } from '../src/deployments';
import { verifyDeploymentIdentity, assertDeploymentIdentity } from '../src/deploymentIdentity';

/**
 * Drift guards, watched failing.
 *
 * The registry RECORDS an ABI hash, a runtime bytecode hash and a selector for every
 * deployment. Until this file existed nothing CHECKED them: the launch path read the
 * factory address, and the two hashes sat in the manifest as documentation. A manifest
 * nobody verifies is a comment with a type annotation.
 *
 * That matters here more than it usually would. This entire migration exists because a
 * factory address kept pointing somewhere reasonable while the contract behind it had
 * been replaced -- and an address that resolves is indistinguishable from an address
 * that is right. The hashes are the part that can tell them apart, so something has to
 * ask.
 *
 * Each test below mutates exactly one axis of identity and requires a refusal naming
 * that axis. A guard that fails for the wrong reason sends the next operator to the
 * wrong file.
 */

/** A live factory stubbed at the byte level, so drift can be simulated exactly. */
function fakeProvider(opts: { code?: string; escrow?: string }): ethers.Provider {
  const d = executableDeployment();
  const code = opts.code ?? '0x' + 'ab'.repeat(10);
  return {
    // A real provider always knows which chain it is on, so a fake that does not would
    // be testing against something that cannot exist.
    getNetwork: async () => ({ chainId: BigInt(d.chainId), name: 'robinhood' }),
    getCode: async () => code,
    call: async () =>
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [opts.escrow ?? d.feeEscrow]),
  } as unknown as ethers.Provider;
}

/** The deployment as it is, but with the runtime hash pinned to whatever `code` is. */
function manifestMatching(code: string, over: Partial<PonsDeployment> = {}): PonsDeployment {
  const d = executableDeployment();
  return {
    ...d,
    runtimeBytecodeLength: (code.length - 2) / 2,
    runtimeBytecodeSha256: ethers.sha256(code).slice(2),
    ...over,
  };
}

describe('deployment identity is verified, not merely recorded', () => {
  const code = '0x' + 'ab'.repeat(10);

  it('passes when the chain agrees with the manifest on every axis', async () => {
    const result = await verifyDeploymentIdentity(manifestMatching(code), fakeProvider({ code }));
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('checks the ABI file the code will actually load, not a copy', async () => {
    // The real deployment, real ABI file on disk, real recorded hash.
    const result = await verifyDeploymentIdentity(
      executableDeployment(),
      fakeProvider({ code: '0x' }) // runtime will mismatch; the ABI check must still pass
    );
    expect(result.checks.find((c) => c.name === 'abi sha256')?.ok).toBe(true);
  });

  it('derives the selector from the ABI rather than trusting the manifest string', async () => {
    const result = await verifyDeploymentIdentity(executableDeployment(), fakeProvider({ code: '0x' }));
    expect(result.checks.find((c) => c.name === 'launch selector')?.ok).toBe(true);
  });
});

describe('each drift axis fails closed, and says which axis', () => {
  const code = '0x' + 'ab'.repeat(10);

  it('refuses a runtime bytecode hash that does not match', async () => {
    const manifest = manifestMatching(code, {
      runtimeBytecodeSha256: 'f'.repeat(64),
    });
    const result = await verifyDeploymentIdentity(manifest, fakeProvider({ code }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/runtime sha256/i);
  });

  it('refuses a runtime length that does not match', async () => {
    const manifest = manifestMatching(code, { runtimeBytecodeLength: 999 });
    const result = await verifyDeploymentIdentity(manifest, fakeProvider({ code }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/runtime length/i);
  });

  // The address resolving is not the same as the address being right. This is the
  // migration's own failure, reduced to one assertion.
  it('refuses an empty account -- a wrong chain or a wrong address', async () => {
    const result = await verifyDeploymentIdentity(executableDeployment(), fakeProvider({ code: '0x' }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/no contract|empty/i);
  });

  it('refuses an ABI whose recorded hash no longer describes the file', async () => {
    const manifest = manifestMatching(code, { abiSha256: '0'.repeat(64) });
    const result = await verifyDeploymentIdentity(manifest, fakeProvider({ code }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/abi sha256/i);
  });

  it('refuses a selector the ABI does not actually produce', async () => {
    const manifest = manifestMatching(code, { launchSelector: '0xdeadbeef' });
    const result = await verifyDeploymentIdentity(manifest, fakeProvider({ code }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/selector/i);
  });

  // The one with no recovery: fees credited where the splitter cannot reach them.
  it('refuses a fee escrow that differs from the live factory', async () => {
    const legacy = deploymentById('pons-v2-legacy-7e1');
    const result = await verifyDeploymentIdentity(
      manifestMatching(code),
      fakeProvider({ code, escrow: legacy.feeEscrow })
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/escrow/i);
  });

  it('reports every axis that drifted, not just the first', async () => {
    const manifest = manifestMatching(code, {
      runtimeBytecodeSha256: 'f'.repeat(64),
      launchSelector: '0xdeadbeef',
    });
    const result = await verifyDeploymentIdentity(manifest, fakeProvider({ code }));
    expect(result.mismatches.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Found by pointing the guard at the real chain: it reported `pons-v1` as drifted on
 * two axes, and the manifest was right both times.
 *
 * A guard that cries wolf about correct data is worse than no guard. It gets
 * rationalised on first sight, and the rationalisation is what survives -- so the next
 * mismatch, the real one, reads as more of the same noise.
 */
describe('historical deployments verify without false alarms', () => {
  it('accepts an ABI file that wraps its array in provenance metadata', async () => {
    // ponsLaunchFactory.json is {_source, _note, contractName, …, abi: [...]}, and the
    // recorded hash covers the inner array. Hashing the wrapper instead reports drift
    // on a file nobody touched.
    const v1 = deploymentById('pons-v1');
    const result = await verifyDeploymentIdentity(v1, fakeProvider({ code: '0x' }));
    expect(result.checks.find((c) => c.name === 'abi sha256')?.ok).toBe(true);
  });

  it('finds the launch signature inside a wrapped ABI', async () => {
    const v1 = deploymentById('pons-v1');
    const result = await verifyDeploymentIdentity(v1, fakeProvider({ code: '0x' }));
    expect(result.checks.find((c) => c.name === 'launch selector')?.ok).toBe(true);
  });

  it('does not demand an escrow from a deployment that has none', async () => {
    // v1 pushes fees from the locker; it exposes no feeEscrow(). Calling it reverts,
    // and treating that revert as drift condemns a contract for lacking a function it
    // was never supposed to have.
    const v1 = deploymentById('pons-v1');
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(4663), name: 'robinhood' }),
      getCode: async () => '0x' + 'cd'.repeat(10),
      call: async () => {
        throw new Error('execution reverted');
      },
    } as unknown as ethers.Provider;
    const result = await verifyDeploymentIdentity(v1, provider);
    expect(result.mismatches.join(' ')).not.toMatch(/escrow/i);
  });

  it('still demands an escrow from a deployment that credits one', async () => {
    // The exemption must be a property of the deployment, not a blanket softening.
    const current = executableDeployment();
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(4663), name: 'robinhood' }),
      getCode: async () => '0x' + 'cd'.repeat(10),
      call: async () => {
        throw new Error('execution reverted');
      },
    } as unknown as ethers.Provider;
    const result = await verifyDeploymentIdentity(current, provider);
    expect(result.mismatches.join(' ')).toMatch(/escrow/i);
  });
});

describe('the assertion form, for the launch path', () => {
  const code = '0x' + 'ab'.repeat(10);

  it('throws naming the deployment and the axis', async () => {
    const manifest = manifestMatching(code, { runtimeBytecodeSha256: 'f'.repeat(64) });
    await expect(assertDeploymentIdentity(manifest, fakeProvider({ code }))).rejects.toThrow(
      /pons-v2-current-7ed.*runtime sha256|runtime sha256.*pons-v2-current-7ed/is
    );
  });

  it('does not throw when identity holds', async () => {
    await expect(
      assertDeploymentIdentity(manifestMatching(code), fakeProvider({ code }))
    ).resolves.toBeUndefined();
  });
});

/**
 * Chain id, which the first version of this guard did not check.
 *
 * It is the cheapest axis and the one most likely to be wrong in practice: every other
 * check reads an address, and the same address on a different chain is a different
 * contract -- or, far more often, no contract at all. `backend/.env` points at testnet
 * by design, and the executable deployment is a mainnet contract, so this is not a
 * hypothetical configuration.
 *
 * Without it the guard still fails, but it fails by reporting the runtime hash as
 * e3b0c442… -- the sha256 of nothing -- which reads as "the bytecode differs" and sends
 * the reader to look for an upgrade that never happened.
 */
describe('chain id is an identity axis', () => {
  const code = '0x' + 'ab'.repeat(10);

  function providerOn(chainId: number): ethers.Provider {
    const d = executableDeployment();
    return {
      getNetwork: async () => ({ chainId: BigInt(chainId), name: 'x' }),
      getCode: async () => code,
      call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['address'], [d.feeEscrow]),
    } as unknown as ethers.Provider;
  }

  it('passes on the deployment’s own chain', async () => {
    const result = await verifyDeploymentIdentity(manifestMatching(code), providerOn(4663));
    expect(result.ok).toBe(true);
  });

  it('refuses on a different chain, naming the axis', async () => {
    const result = await verifyDeploymentIdentity(manifestMatching(code), providerOn(46630));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/chain/i);
  });

  it('says which chain it found, not merely that it was wrong', async () => {
    const result = await verifyDeploymentIdentity(manifestMatching(code), providerOn(46630));
    expect(result.mismatches.join(' ')).toContain('46630');
  });

  // A provider that cannot say which chain it is on has not proven it is the right one.
  it('treats an unreadable network as a mismatch rather than a pass', async () => {
    const d = executableDeployment();
    const provider = {
      getNetwork: async () => {
        throw new Error('no network');
      },
      getCode: async () => code,
      call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['address'], [d.feeEscrow]),
    } as unknown as ethers.Provider;
    const result = await verifyDeploymentIdentity(manifestMatching(code), provider);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/chain/i);
  });
});

/**
 * A wrong factory ADDRESS, distinct from a wrong contract at the right address.
 *
 * The closure order lists these separately and they really are different failures. A
 * wrong address is usually a typo, a copied config, or a registry entry pointing at the
 * previous deployment; a wrong runtime hash at the right address is an upgrade. The
 * first is fixed in a settings file, the second needs someone to read a changelog, and a
 * guard that cannot tell them apart sends the operator to the wrong one.
 */
describe('a wrong factory address is caught and named', () => {
  const realCode = '0x' + 'ab'.repeat(10);

  /** Answers only for the expected address; anything else is an empty account, which is
   *  what a wrong address looks like on a real chain most of the time. */
  function providerAnsweringOnlyFor(expected: string): ethers.Provider {
    const d = executableDeployment();
    return {
      getNetwork: async () => ({ chainId: BigInt(d.chainId), name: 'x' }),
      getCode: async (address: string) =>
        String(address).toLowerCase() === expected.toLowerCase() ? realCode : '0x',
      call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['address'], [d.feeEscrow]),
    } as unknown as ethers.Provider;
  }

  it('passes when the manifest names the address that holds the contract', async () => {
    const d = executableDeployment();
    const result = await verifyDeploymentIdentity(
      manifestMatching(realCode),
      providerAnsweringOnlyFor(d.factory)
    );
    expect(result.ok).toBe(true);
  });

  it('refuses when the manifest names an address holding nothing', async () => {
    const wrong = '0x000000000000000000000000000000000000BEEF';
    const result = await verifyDeploymentIdentity(
      manifestMatching(realCode, { factory: wrong }),
      providerAnsweringOnlyFor(executableDeployment().factory)
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toMatch(/no contract|empty/i);
  });

  // The migration's exact near-miss: a real, live, correct contract -- just not this one.
  it('refuses the superseded factory even though it is a real live contract', async () => {
    const legacy = deploymentById('pons-v2-legacy-7e1');
    const d = executableDeployment();
    const provider = {
      getNetwork: async () => ({ chainId: BigInt(d.chainId), name: 'x' }),
      // The legacy factory exists and answers. That is the entire difficulty.
      getCode: async () => '0x' + 'cd'.repeat(10),
      call: async () =>
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [legacy.feeEscrow]),
    } as unknown as ethers.Provider;
    const result = await verifyDeploymentIdentity({ ...d, factory: legacy.factory }, provider);
    expect(result.ok).toBe(false);
    // Both the bytecode and the escrow give it away, and the report names both.
    expect(result.mismatches.join(' ')).toMatch(/runtime/i);
    expect(result.mismatches.join(' ')).toMatch(/escrow/i);
  });
});
