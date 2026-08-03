import { ethers } from 'ethers';
import { config } from './config';
import { PONS_FACTORY_ABI_FRAGMENT } from './ponsEncoder';

export function createProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
}

/**
 * Reads the CURRENT launch fee directly from the Pons factory contract. Per Part 5's audit,
 * this must be called immediately before every launch transaction is built -- never cached,
 * never assumed constant, since it's owner-settable on Pons's side and can change without
 * notice.
 */
export async function getLiveFeeWei(provider: ethers.Provider): Promise<bigint> {
  const factory = new ethers.Contract(config.PONS_FACTORY_ADDRESS, PONS_FACTORY_ABI_FRAGMENT, provider);
  const fee = await factory.creationFee();
  return BigInt(fee.toString());
}

/**
 * Reads the hot treasury wallet's balance. Backs Part 5 mitigation #7 -- both the
 * pre-launch admission check in validator.ts and the periodic watch in
 * treasuryPolicy.ts. Read live for the same reason the fee is: a balance that was
 * correct a minute ago says nothing about a wallet someone is draining now.
 */
export async function getBalanceWei(provider: ethers.Provider, address: string): Promise<bigint> {
  return provider.getBalance(address);
}
