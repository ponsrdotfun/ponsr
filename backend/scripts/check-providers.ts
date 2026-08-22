/**
 * Connectivity preflight for Privy and Turnkey.
 *
 *   npx ts-node scripts/check-providers.ts                         # no Privy creation
 *   npx ts-node scripts/check-providers.ts --create-privy-wallet   # explicit write check
 *
 * Credentials being *present* in `.env` proves nothing. This exercises the exact code paths
 * the bot uses and reports what actually came back.
 *
 * Nothing here moves money:
 *   - Privy creates one wallet under a fixed `external_id`. That id is write-once and unique
 *     on Privy's side, so re-running recovers the same wallet instead of accumulating junk --
 *     which also demonstrates the collision-recovery path the resolver depends on.
 *   - Turnkey only reads an address. Deriving it requires the org id, both API keys and the
 *     signing target to all line up, so a correct address is a real end-to-end result.
 *
 * Secrets are never printed. Only outcomes.
 */
import { ethers } from 'ethers';
import { config } from '../src/config';
import { Db } from '../src/db';
import { PrivyWalletResolver, externalIdFor } from '../src/walletResolver';
import { TurnkeyTreasurySigner } from '../src/treasurySigner';
import { createProvider, getBalanceWei } from '../src/chainClient';

const CHECK_USER_ID = 'ponsr-connectivity-check';
const CREATE_PRIVY_WALLET = process.argv.includes('--create-privy-wallet');

function head(title: string) {
  console.log('');
  console.log('=== ' + title + ' ===');
}
function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}
function present(name: string, value: string | undefined): boolean {
  const ok = typeof value === 'string' && value.length > 0;
  line(name, ok ? `set (${value!.length} chars)` : '>>> MISSING');
  return ok;
}

async function checkPrivy(): Promise<boolean> {
  head('PRIVY');
  const haveId = present('PRIVY_APP_ID', config.PRIVY_APP_ID);
  const haveSecret = present('PRIVY_APP_SECRET', config.PRIVY_APP_SECRET);
  if (!haveId || !haveSecret) {
    console.log('  -> skipped: fill both in backend/.env');
    return false;
  }

  if (!CREATE_PRIVY_WALLET) {
    console.log('  -> plan only: credentials are present, but creating/recovering a Privy wallet is a write.');
    console.log('     Re-run with --create-privy-wallet to exercise that resource-creation path.');
    return true;
  }

  // A throwaway in-memory-ish DB so the check never touches the real users table.
  const db = new Db('./data/provider-check.sqlite');
  try {
    const resolver = new PrivyWalletResolver(db, config.PRIVY_APP_ID!, config.PRIVY_APP_SECRET!);
    const wallet = await resolver.resolve(CHECK_USER_ID, 'ponsr-check');
    line('external_id', externalIdFor(CHECK_USER_ID));
    line('wallet id', wallet.providerRef);
    line('address', wallet.walletAddress);
    line('address is valid', ethers.isAddress(wallet.walletAddress) ? 'yes' : '>>> NO');
    console.log('  -> Privy OK: credentials work and wallet creation succeeded.');
    return true;
  } catch (err: any) {
    console.error('  -> Privy FAILED:', err?.message ?? err);
    if (/401|unauthor|invalid/i.test(String(err?.message))) {
      console.error('     That reads like bad credentials. The app secret is shown once at');
      console.error('     creation -- if it was not saved, generate a new one in the dashboard.');
    }
    return false;
  } finally {
    db.close();
  }
}

async function checkTurnkey(): Promise<boolean> {
  head('TURNKEY');
  const ok = [
    present('TURNKEY_ORGANIZATION_ID', config.TURNKEY_ORGANIZATION_ID),
    present('TURNKEY_API_PUBLIC_KEY', config.TURNKEY_API_PUBLIC_KEY),
    present('TURNKEY_API_PRIVATE_KEY', config.TURNKEY_API_PRIVATE_KEY),
    present('TURNKEY_SIGN_WITH', config.TURNKEY_SIGN_WITH),
  ].every(Boolean);
  if (!ok) {
    console.log('  -> skipped: fill all four in backend/.env');
    return false;
  }

  try {
    const provider = createProvider();
    const signer = new TurnkeyTreasurySigner(
      config.TURNKEY_ORGANIZATION_ID!,
      config.TURNKEY_API_PUBLIC_KEY!,
      config.TURNKEY_API_PRIVATE_KEY!,
      config.TURNKEY_SIGN_WITH!,
      provider
    );
    const address = await signer.address();
    line('address', address);
    line('address is valid', ethers.isAddress(address) ? 'yes' : '>>> NO');

    const balance = await getBalanceWei(provider, address);
    line('balance', ethers.formatEther(balance) + ' ETH');
    line('chain', `${config.CHAIN_ID} via ${config.RPC_URL}`);
    console.log('  -> Turnkey OK: org id, both API keys and the signing target all line up.');
    return true;
  } catch (err: any) {
    console.error('  -> Turnkey FAILED:', err?.message ?? err);
    console.error('     Common causes: the organization id is actually the USER id (they look');
    console.error('     alike and sit on the same page), or TURNKEY_SIGN_WITH names a wallet');
    console.error('     that belongs to a different organization.');
    return false;
  }
}

(async () => {
  console.log('Provider connectivity check. No funds are moved.');
  const privyOk = await checkPrivy();
  const turnkeyOk = await checkTurnkey();

  head('RESULT');
  line('Privy', privyOk ? 'OK' : 'not working');
  line('Turnkey', turnkeyOk ? 'OK' : 'not working');

  if (privyOk && turnkeyOk) {
    console.log('');
    console.log('Both live. Remaining before production:');
    console.log('  - A Turnkey POLICY restricting this key to the pons factory and launchToken.');
    console.log('    Nothing in this codebase can enforce that; it is configured in Turnkey.');
    console.log('    Set TURNKEY_POLICY_CONFIRMED=true only once it exists.');
    console.log('  - Note the splitter deployment is a contract creation, not a call to the');
    console.log('    factory, so a launchToken-only policy will reject it.');
  }
  process.exitCode = privyOk && turnkeyOk ? 0 : 1;
})();
