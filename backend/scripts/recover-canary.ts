/**
 * Read-only recovery for an interrupted canary run.
 *
 *   npm run recover:canary
 *
 * The journal refuses to start a new canary while anything is unresolved, and told the
 * operator to "recover it read-only". There was no command. Evidence nobody can act on is
 * a slower way of having none, and the instruction pointed at a door that did not exist.
 *
 * KEYLESS BY CONSTRUCTION
 * -----------------------
 * This reads a provider and the journal. It constructs no signer, reads no Turnkey or
 * private-key variable, and cannot broadcast: `recoverCanary` takes four readers and an
 * address, and there is no parameter through which a transaction could be sent. Running it
 * on a machine that holds no credentials is the point, not a coincidence.
 *
 * It advances what the chain can prove and leaves everything else exactly where it was.
 * An unreadable receipt stays ambiguous. A never-bound intent stays unclassified, because
 * calling it reverted would unblock a resend of a launch that may have landed.
 */
import { ethers } from 'ethers';
import { config } from '../src/config';
import { CanaryJournal } from '../src/canaryJournal';
import { recoverCanary } from '../src/canaryRecovery';
import { deploymentById, PonsDeployment } from '../src/deployments';
import { PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';
import { pinnedTreasuryAddress } from '../src/canarySignerBoundary';

const JOURNAL_PATH = process.env.CANARY_JOURNAL ?? './data/canary-journal.sqlite';

function line(label: string, value: unknown) {
  console.log(`  ${String(label).padEnd(26)} ${value}`);
}

async function main() {
  console.log('=== CANARY RECOVERY (read-only; nothing is signed or sent) ===');
  line('journal', JOURNAL_PATH);

  const journal = new CanaryJournal(JOURNAL_PATH);
  const open = journal.unresolved();
  if (open.length === 0) {
    console.log('\nNothing unresolved. The journal is clean.');
    journal.close();
    return;
  }

  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const treasury = pinnedTreasuryAddress(config as { TURNKEY_SIGN_WITH?: string });
  line('treasury (pinned)', treasury);
  line('rpc', config.RPC_URL);
  console.log(`\n${open.length} unresolved row(s):\n`);
  for (const r of open) {
    line(`  #${r.id} ${r.op}`, `state=${r.state} tx=${r.txHash ?? '(never bound)'}`);
  }

  const results = await recoverCanary(journal, {
    resolveDeployment: (id) => {
      try {
        return deploymentById(id);
      } catch {
        return null;
      }
    },
    readReceipt: async (txHash) => {
      const r = await provider.getTransactionReceipt(txHash);
      if (!r) return null;
      return {
        status: r.status === null || r.status === undefined ? null : Number(r.status),
        logs: r.logs as unknown as readonly { address?: string; topics: readonly string[]; data: string }[],
        contractAddress: r.contractAddress ?? null,
      };
    },
    readLaunchRecord: async (deployment: PonsDeployment, token: string) => {
      const factory = new ethers.Contract(deployment.factory, PONS_V2_CURRENT_ABI, provider);
      const raw = await factory.getLaunchedToken(token);
      return {
        token: String(raw.token ?? raw[0]),
        curve: String(raw.curve ?? raw[1]),
        deployer: String(raw.deployer ?? raw[2]),
        creatorFeeRecipient: String(raw.creatorFeeRecipient ?? raw[3]),
        pairToken: String(raw.pairToken ?? raw[4]),
        exists: Boolean(raw.exists ?? raw[14]),
      };
    },
    readCode: (address) => provider.getCode(address),
    treasuryAddress: treasury,
  });

  console.log('\n=== RESULT ===');
  let stillOpen = 0;
  for (const r of results) {
    if (r.confirmed) {
      line(`  #${r.id} ${r.op}`, 'RESOLVED — confirmed against the chain');
      continue;
    }
    stillOpen += 1;
    line(`  #${r.id} ${r.op}`, 'STILL OPEN');
    for (const p of r.problems) console.log(`      ${p}`);
  }

  console.log();
  if (stillOpen === 0) {
    console.log('All rows resolved. A new canary run may be prepared.');
  } else {
    console.log(`${stillOpen} row(s) remain unresolved, so a new canary run is still refused.`);
    console.log('That refusal is the point: an ambiguous irreversible action must be settled by');
    console.log('looking, not by sending a replacement. The reasons above are stored in the');
    console.log('journal and survive this terminal.');
  }
  journal.close();
  process.exitCode = stillOpen === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
