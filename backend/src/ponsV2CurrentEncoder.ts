import { ethers } from 'ethers';
import { LaunchParams } from './ponsEncoder';
import { NATIVE_ETH } from './pairTokens';
import { PonsDeployment, executableDeployment } from './deployments';
import currentAbi from './abi/ponsV2CurrentLaunchFactory.json';

/**
 * Calldata for the pons deployment that is actually live.
 *
 * There are now three launch functions in this repository and they are not
 * interchangeable:
 *
 *   v1                 launchToken(params, launchConfigId, dexId, salt)        0x686399cb
 *   v2 superseded      launchToken(params(…expectedEconomics), cfg, pairToken) 0xa41d5f2b
 *   v2 current         launchToken(params(…expectedEconomics, salt), cfg, pair) 0xf35abbcf
 *
 * The current one differs from its predecessor by a single field -- `salt` at the end
 * of `TokenParams` -- and that one field moves the selector. Sending the older
 * encoding to the current factory does not produce a helpful error; it reverts a
 * transaction that has already paid gas. Verified by `eth_call` before this was
 * written.
 *
 * `launchTokenFor` is deliberately not exposed here. It is callable only by the
 * configured forwarder, and using it would be a different product: it exists to
 * record somebody other than the caller as the launch's original deployer. Through
 * this path the treasury is the on-chain deployer and the user receives the creator
 * share through the splitter, which is what the reply and the docs must say.
 */

export const PONS_V2_CURRENT_ABI = currentAbi as ethers.InterfaceAbi;

export interface CurrentV2LaunchParams extends Omit<LaunchParams, 'dexId' | 'salt'> {
  pairToken: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: string;
  /** CREATE2 salt. Fixes the launched token's address in advance, which is what makes
   *  a retry of the same request collide rather than mint a second token. */
  salt: string;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The salt for one launch request.
 *
 * Domain-separated, and every part of the preimage earns its place:
 *
 *   - the literal prefix keeps this value out of any other keccak namespace;
 *   - the chain id stops the same request predicting the same address on two chains;
 *   - the factory address stops it colliding across deployments, which matters most
 *     right after a migration, when a retried request could otherwise derive an
 *     address that already holds a token launched through the old factory;
 *   - the request id -- the tweet -- is what makes it reproducible at all.
 *
 * Deliberately NOT the v1 `saltForTweet`, which hashes the tweet id alone. Reusing
 * that value here would place the same salt in a different protocol's address
 * derivation, and the whole point of a salt is that it is scoped.
 *
 * This does not replace the database's idempotency claim. That claim stops the bot
 * doing the work twice; this stops the chain accepting it twice if the claim is ever
 * lost. Two independent barriers, and the fee is only spent once behind both.
 */
export function launchSalt(deployment: Pick<PonsDeployment, 'chainId' | 'factory'>, requestId: string): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(
      `ponsr:current-v2:launch:${deployment.chainId}:${deployment.factory.toLowerCase()}:${requestId}`
    )
  );
}

/**
 * Builds the launch, aimed at whichever deployment is executable.
 *
 * The destination comes from the registry rather than from configuration: an address
 * that can be set independently of the ABI is how a correct encoder ends up pointed
 * at a contract that cannot decode it.
 *
 * `value` is exactly the fee. Anything above it is treated by the factory as an
 * initial buy, and the treasury must never buy into a token it launched for someone
 * else.
 */
export function buildCurrentV2LaunchCalldata(
  params: CurrentV2LaunchParams,
  launchFeeWei: bigint,
  deployment: PonsDeployment = executableDeployment()
): { to: string; data: string; value: bigint } {
  if (!ethers.isAddress(params.pairToken)) {
    throw new Error(`pairToken is not an address: ${params.pairToken}`);
  }
  if (!BYTES32.test(params.expectedEconomics)) {
    throw new Error(`expectedEconomics is not a bytes32: ${params.expectedEconomics}`);
  }
  if (!BYTES32.test(params.salt)) {
    throw new Error(`salt is not a bytes32: ${params.salt}`);
  }
  if (!Number.isInteger(params.creatorTaxBps) || params.creatorTaxBps < 0 || params.creatorTaxBps > 10_000) {
    throw new Error(`creatorTaxBps out of range: ${params.creatorTaxBps}`);
  }

  const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);
  const data = iface.encodeFunctionData(deployment.launchSignature, [
    {
      name: params.tokenName,
      symbol: params.tokenSymbol,
      logo: params.logo,
      description: params.description,
      socials: {
        twitter: params.socials.twitter,
        telegram: params.socials.telegram,
        discord: params.socials.discord,
        website: params.socials.website,
        farcaster: params.socials.farcaster,
      },
      creatorFeeRecipient: params.feeWallet,
      creatorTaxBps: params.creatorTaxBps,
      buybackEnabled: params.buybackEnabled,
      expectedEconomics: params.expectedEconomics,
      salt: params.salt,
    },
    params.launchConfigId,
    params.pairToken,
  ]);

  // Cheap, and it has already earned itself once: the whole migration exists because
  // calldata went to a factory that could not decode it.
  if (!data.startsWith(deployment.launchSelector)) {
    throw new Error(
      `encoded selector ${data.slice(0, 10)} does not match ${deployment.id}'s ${deployment.launchSelector}`
    );
  }

  return { to: deployment.factory, data, value: launchFeeWei };
}

/** Reads a current-V2 launch back out of the receipt's own logs. */
export function extractCurrentV2LaunchDetails(
  logs: readonly ethers.Log[]
): { token: string; curve: string; pairToken: string; originalDeployer?: string } | null {
  const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'TokenLaunched') {
        const args = parsed.args as unknown as Record<string, unknown>;
        return {
          token: String(args.token),
          curve: String(args.curve),
          pairToken: String(args.pairToken),
          originalDeployer:
            args.originalDeployer !== undefined
              ? String(args.originalDeployer)
              : args.deployer !== undefined
                ? String(args.deployer)
                : undefined,
        };
      }
    } catch {
      /* Receipts carry logs from every contract the call touched. */
    }
  }
  return null;
}

export function isNativePair(pairToken: string): boolean {
  return pairToken.toLowerCase() === NATIVE_ETH;
}
