/**
 * Every pons deployment Ponsr knows about, and exactly one it may launch through.
 *
 * WHY THIS REPLACED A SINGLE MUTABLE ADDRESS
 * ------------------------------------------
 * Ponsr reported "the launchpad is closed" for a week. That report was true about the
 * contract it was reading -- `0x7E1EAbd5…`, whose `launchEnabled` really is false --
 * and false about pons, which had moved to `0x7eD598…EC7e` on 2026-08-03 and left it
 * open. One `PONS_V2_FACTORY_ADDRESS` setting made a superseded deployment and the
 * current one indistinguishable, so every guard read the wrong contract confidently.
 *
 * Address alone was never enough anyway. The two V2 deployments take DIFFERENT
 * calldata: the current one adds `salt` to `TokenParams`, which changes the selector
 * from `0xa41d5f2b` to `0xf35abbcf`. Pointing the old encoder at the new address
 * produces a reverted transaction that has already paid gas. And they credit fees to
 * DIFFERENT escrows, which is worse: the escrow is baked immutably into each
 * splitter, escrow claims pay `msg.sender`, and there is no `claimFor` -- so a
 * splitter built against the wrong escrow holds a creator's fees where nothing can
 * ever reach them.
 *
 * So a deployment is a bound set of facts, not an address: ABI, escrow, selector,
 * schema, and the hashes that prove the contract on chain is the one described here.
 *
 * HISTORY STAYS READABLE
 * ----------------------
 * Both older deployments carry real launches that the board shows and the ledger
 * counts. They remain indexable forever. What they are not is executable: exactly one
 * deployment may receive a launch, and the type system plus `executableDeployment()`
 * are how that stays true.
 */

export type TokenParamsVersion = 'v1' | 'v2-no-salt' | 'v2-salt';

export interface PonsDeployment {
  /** Stable identifier. Written into every launch record, so it must never be reused
   *  for a different contract even if an address is retired. */
  id: string;
  label: string;
  chainId: number;
  factory: string;
  /** First block that could contain this deployment's events. Reading from genesis
   *  works but scans millions of empty blocks; reading from later silently misses
   *  approvals, which looks identical to pons never having granted them. */
  startBlock: number;
  /** Path relative to `src/`, so the artifact travels with the code that decodes it. */
  abiPath: string;
  /** SHA-256 of the ABI in canonical form: `JSON.stringify` with sorted keys and no
   *  spaces. Pins the interface, so a silently swapped artifact fails a check rather
   *  than producing calldata nobody meant. */
  abiSha256: string;
  runtimeBytecodeLength: number;
  runtimeBytecodeSha256: string;
  /** Where this deployment credits or pushes creator fees. On v1 this is the locker,
   *  which pushes; on v2 it is an escrow, which credits and must be claimed. */
  feeEscrow: string;
  launchDeployer?: string;
  launchForwarder?: string;
  /** First four bytes of the launch function this deployment actually accepts. */
  launchSelector: string;
  launchSignature: string;
  tokenParamsVersion: TokenParamsVersion;
  /** False means: read its events, never send it a transaction. */
  executable: boolean;
  /** Why it is not executable, for an operator reading a refusal. */
  supersededBy?: string;
}

const V1: PonsDeployment = {
  id: 'pons-v1',
  label: 'pons v1 (Uniswap V3 era)',
  chainId: 4663,
  factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  startBlock: 8_991_118,
  abiPath: 'abi/ponsLaunchFactory.json',
  abiSha256: '3e019dab148704e3e16bb8b9265f11c37bda15f4d46f67c182f2e84e989c831c',
  runtimeBytecodeLength: 24_353,
  runtimeBytecodeSha256: '834a3a3f3c5a7ca4db3be3ca96f34c99cab44e01822aef04ea9d7104a2159507',
  // v1 pushes fees from the locker rather than escrowing them, so this is the locker.
  feeEscrow: '0x736D76699C26D0d966744cAe304C000d471f7F35',
  launchSelector: '0x686399cb',
  launchSignature:
    'launchToken((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32)',
  tokenParamsVersion: 'v1',
  executable: false,
  supersededBy: 'pons-v2-current-7ed',
};

const V2_LEGACY: PonsDeployment = {
  id: 'pons-v2-legacy-7e1',
  label: 'pons v2 (superseded 2026-08-03)',
  chainId: 4663,
  factory: '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8',
  startBlock: 23_551_520,
  abiPath: 'abi/ponsV2LaunchFactory.json',
  abiSha256: 'ce9e0091f4c4442b093e6fb671e8367033c2a9386027559281e5ad47b0433de8',
  runtimeBytecodeLength: 22_757,
  runtimeBytecodeSha256: '6796fb0e5c1687698e7f2dcea07d855606396345b14c8dd212eb3ce3544cad63',
  feeEscrow: '0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c',
  // No salt in TokenParams, hence a different selector from the current deployment.
  launchSelector: '0xa41d5f2b',
  launchSignature:
    'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32),uint256,address)',
  tokenParamsVersion: 'v2-no-salt',
  executable: false,
  supersededBy: 'pons-v2-current-7ed',
};

const V2_CURRENT: PonsDeployment = {
  id: 'pons-v2-current-7ed',
  label: 'pons v2 (current)',
  chainId: 4663,
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  startBlock: 26_841_846,
  abiPath: 'abi/ponsV2CurrentLaunchFactory.json',
  abiSha256: '1d424e7b711cdd4d23c08ba2ccc12bc2f478e5dc794e8cdc6bd3fd35fa85b323',
  runtimeBytecodeLength: 24_177,
  runtimeBytecodeSha256: '226a042e6d68a69a6038d4fda211925b03eb5299399434b87a7877f79f6e3848',
  feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  launchDeployer: '0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42',
  launchForwarder: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  launchSelector: '0xf35abbcf',
  launchSignature:
    'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)',
  tokenParamsVersion: 'v2-salt',
  executable: true,
};

/** Oldest first, so anything iterating for indexing reads history in order. */
export const DEPLOYMENTS: readonly PonsDeployment[] = [V1, V2_LEGACY, V2_CURRENT];

/**
 * The one deployment a launch may be sent to.
 *
 * Throws rather than returning undefined: there is no sensible fallback, and a caller
 * that silently skipped a launch would be worse than one that failed loudly.
 */
export function executableDeployment(): PonsDeployment {
  const executable = DEPLOYMENTS.filter((d) => d.executable);
  if (executable.length !== 1) {
    throw new Error(
      `exactly one deployment must be executable, found ${executable.length}: ` +
        executable.map((d) => d.id).join(', ')
    );
  }
  return executable[0];
}

export function deploymentById(id: string): PonsDeployment {
  const found = DEPLOYMENTS.find((d) => d.id === id);
  if (!found) {
    throw new Error(
      `unknown deployment "${id}". Known: ${DEPLOYMENTS.map((d) => d.id).join(', ')}`
    );
  }
  return found;
}

/** Everything whose events still need reading, which is all of them. A launch made
 *  through a superseded factory did not stop existing when pons moved on. */
export function indexableDeployments(): readonly PonsDeployment[] {
  return DEPLOYMENTS;
}

/** Resolves an address to a deployment, for reading historical records back. */
export function deploymentByFactory(factory: string): PonsDeployment | undefined {
  return DEPLOYMENTS.find((d) => d.factory.toLowerCase() === factory.toLowerCase());
}
