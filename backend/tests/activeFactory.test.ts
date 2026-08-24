import { activeFactoryAddress } from '../src/chainClient';
import { config } from '../src/config';
import { executableDeployment, deploymentById } from '../src/deployments';

/**
 * Which factory the guards read, when the bot launches through v2.
 *
 * `launchTarget` was migrated to the registry; `chainClient` was not. So flipping
 * PONS_FACTORY_VERSION to v2 would have built calldata for the CURRENT factory while
 * every pre-launch guard -- the live fee, launchEnabled, the whitelist, the launch
 * config -- read the SUPERSEDED one, whose launchEnabled is false.
 *
 * The failure is not that launches break. It is that they are refused, loudly and for
 * an entirely fictional reason, by a check whose own header comment says: "Checking the
 * wrong factory before spending money is worse than not checking, because it produces a
 * confident answer about somewhere else."
 */
describe('activeFactoryAddress', () => {
  const real = process.env.PONS_FACTORY_VERSION;
  afterEach(() => {
    if (real === undefined) delete process.env.PONS_FACTORY_VERSION; else process.env.PONS_FACTORY_VERSION = real;
  });

  it('reads the executable deployment when launching through v2', () => {
    process.env.PONS_FACTORY_VERSION = 'v2';
    expect(activeFactoryAddress().toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
  });

  it('never resolves to the superseded factory', () => {
    process.env.PONS_FACTORY_VERSION = 'v2';
    expect(activeFactoryAddress().toLowerCase()).not.toBe(
      deploymentById('pons-v2-legacy-7e1').factory.toLowerCase()
    );
  });

  it('still reads v1 when v1 is selected, so rollback stays honest', () => {
    process.env.PONS_FACTORY_VERSION = 'v1';
    expect(activeFactoryAddress().toLowerCase()).toBe(
      String(config.PONS_FACTORY_ADDRESS).toLowerCase()
    );
  });

  it('agrees with the launch target rather than being set beside it', () => {
    process.env.PONS_FACTORY_VERSION = 'v2';
    // The guard and the calldata must name one contract. Two settings that can disagree
    // is the whole shape of this migration's root cause.
    expect(activeFactoryAddress().toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
  });
});
