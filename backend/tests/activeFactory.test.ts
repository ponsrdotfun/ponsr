import { activeFactoryAddress } from '../src/chainClient';
import { executableDeployment, deploymentById } from '../src/deployments';

/**
 * Which factory the guards read.
 *
 * `launchTarget` was migrated to the registry; `chainClient` was not, so flipping the old
 * `PONS_FACTORY_VERSION` to v2 would have built calldata for the CURRENT factory while
 * every pre-launch guard -- the live fee, launchEnabled, the whitelist, the launch config
 * -- read a different one. The failure is not that launches break. It is that they are
 * refused, loudly and for an entirely fictional reason, by a check whose own header says:
 * "Checking the wrong factory before spending money is worse than not checking, because it
 * produces a confident answer about somewhere else."
 *
 * The setting was removed on 2026-08-26, so these tests no longer set an environment
 * variable to steer the answer. That is the point: there is nothing left to steer with,
 * and the case that used to prove "v1 is still selectable" is now the case that proves it
 * is not. Historical v1 READS are covered in `v1HistoricalReader.test.ts`.
 */
describe('activeFactoryAddress', () => {
  const ENV = ['PONS_FACTORY_VERSION', 'PONS_FACTORY_ADDRESS'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('reads the executable deployment', () => {
    expect(activeFactoryAddress().toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
  });

  it('never resolves to the superseded v2 factory', () => {
    expect(activeFactoryAddress().toLowerCase()).not.toBe(
      deploymentById('pons-v2-legacy-7e1').factory.toLowerCase()
    );
  });

  it('never resolves to v1, whatever the environment says', () => {
    // Both of the settings that used to be able to produce this answer, at once.
    process.env.PONS_FACTORY_VERSION = 'v1';
    process.env.PONS_FACTORY_ADDRESS = deploymentById('pons-v1').factory;
    expect(activeFactoryAddress().toLowerCase()).not.toBe(
      deploymentById('pons-v1').factory.toLowerCase()
    );
    expect(activeFactoryAddress().toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
  });

  it('agrees with the launch target rather than being set beside it', () => {
    // The guard and the calldata must name one contract. Two settings that can disagree is
    // the whole shape of this migration's root cause.
    expect(activeFactoryAddress().toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
  });
});
