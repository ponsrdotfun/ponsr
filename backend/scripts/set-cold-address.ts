/**
 * Validates a cold treasury address and writes it to `backend/.env`.
 *
 *   npx ts-node scripts/set-cold-address.ts 0xYourColdWalletAddress
 *
 * WHY THIS TAKES AN ADDRESS AND NEVER A PRIVATE KEY
 * -------------------------------------------------
 * The cold wallet's key must never exist on the machine that runs the bot. That machine holds
 * the hot signer's credentials, the provider API keys, and the parser key; a cold key stored
 * beside them is not cold, and the hot/cold split it appears to create is exactly the kind
 * that "looks real and isn't" that `treasuryPolicy.checkTreasurySetup` exists to catch.
 *
 * The backend never signs as the cold wallet -- CLAUDE.md is explicit that no cold signer
 * belongs in this codebase, because an automated cold -> hot refill would rebuild the single
 * point of failure the split removes (Part 5 §3.6). Top-ups and sweeps are operator actions
 * performed by hand. So the only thing the backend needs is the ADDRESS, which is public.
 *
 * Generate the wallet somewhere this machine is not: a hardware wallet is best, a fresh
 * account in a wallet app on another device is acceptable. Bring back the address only.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE
 * ---------------------------------
 * A wrong cold address fails silently. Nothing reads it until the day funds are swept there,
 * and by then the mistake is unrecoverable. Each check below corresponds to a way that has
 * actually happened to people:
 *
 *   - not a valid address / bad checksum -> a typo or a truncated paste
 *   - equal to the hot wallet            -> a split that is one wallet wearing two names
 *   - the zero address                   -> a placeholder that survived into configuration
 *   - has contract code                  -> an address that may have no way to send funds out
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';

const ENV_PATH = path.join(__dirname, '..', '.env');
const KEY = 'TREASURY_COLD_ADDRESS';
const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function setEnv(contents: string, key: string, value: string): string {
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, `${key}=${value}`);
  return contents.replace(/\n*$/, `\n${key}=${value}\n`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: set-cold-address.ts 0xYourColdWalletAddress');
    console.error('\nThe ADDRESS only. Never pass, paste, or store the cold wallet\'s private key.');
    process.exit(1);
  }

  console.log('=== COLD TREASURY ADDRESS ===\n');

  let cold: string;
  try {
    // getAddress rejects a bad checksum, which is what catches a single mistyped character in
    // an address that is otherwise the right length.
    cold = ethers.getAddress(arg.trim());
  } catch {
    console.error(`Not a valid address: ${arg}`);
    console.error('A mixed-case address must also have a valid checksum -- if you retyped it by');
    console.error('hand rather than copying, that is the likely cause.');
    process.exit(1);
  }
  line('address', cold);

  if (cold === ethers.ZeroAddress) {
    console.error('\nThat is the zero address. Funds sent there are destroyed.');
    process.exit(1);
  }

  const hot = config.TURNKEY_SIGN_WITH;
  if (hot) {
    line('hot wallet', hot);
    if (cold.toLowerCase() === hot.toLowerCase()) {
      console.error('\nThis is the HOT wallet address. A split where both halves are the same');
      console.error('wallet passes every runtime check and protects nothing -- it is precisely');
      console.error('the failure checkTreasurySetup refuses to call healthy.');
      process.exit(1);
    }
    line('distinct from hot', 'yes');
  } else {
    console.log('\n  (TURNKEY_SIGN_WITH is not set, so the hot wallet could not be compared.)');
  }

  // An address with code may be a contract with no withdrawal path, or one that reverts on
  // plain transfers. A cold wallet should be an ordinary externally-owned account.
  try {
    const provider = new ethers.JsonRpcProvider(MAINNET_RPC, 4663);
    const code = await provider.getCode(cold);
    if (code !== '0x') {
      console.error('\nThis address has contract code on mainnet. A cold wallet should be an');
      console.error('ordinary account -- a contract may have no way to move funds back out.');
      process.exit(1);
    }
    line('contract code', 'none (a normal account)');
    line('balance', `${ethers.formatEther(await provider.getBalance(cold))} ETH`);
  } catch (err: any) {
    // Not fatal: the checks that matter most are local, and an RPC outage should not block
    // configuring an address the operator has verified themselves.
    console.log(`\n  (Could not reach mainnet to check for contract code: ${String(err?.message ?? err).slice(0, 80)})`);
  }

  const contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  fs.writeFileSync(ENV_PATH, setEnv(contents, KEY, cold), { encoding: 'utf8' });

  console.log(`\nWritten to backend/.env as ${KEY}.`);
  console.log('\nRemaining, and neither is done by this script:');
  console.log('  1. Set the same value on the host: fly secrets set TREASURY_COLD_ADDRESS=' + cold);
  console.log('  2. Confirm the cold wallet\'s key is somewhere this machine cannot reach,');
  console.log('     and that you can still sign with it. An address you cannot spend from is');
  console.log('     not a treasury.');
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
