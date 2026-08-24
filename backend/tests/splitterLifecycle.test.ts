import { deploySplitter } from '../src/splitterDeployer';
import { deploymentById } from '../src/deployments';

/**
 * Driving deploySplitter itself, with a fake signer.
 *
 * Round 2 added `hooks` to this function's signature, wired callbacks at the call site,
 * wrote tests that manufactured journal rows by hand, and reported the splitter as
 * journalled. The hooks were never invoked. The parameter existed, the callbacks existed,
 * and nothing connected them -- so a crash after the splitter broadcast still lost the hash
 * and a rerun could deploy a second permanent contract.
 *
 * Every test that was green tested a helper in isolation. None of them entered this
 * function. That is the difference between proving the parts work and proving the path
 * runs, and it is why these tests inject a fake signer instead of building fixture rows:
 * the only acceptable evidence that a lifecycle happens is a lifecycle happening.
 */

const D = deploymentById('pons-v2-current-7ed');
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';

/** Records the exact order in which the real function reaches each boundary. */
function harness(opts: { receipt?: unknown; sendThrows?: boolean } = {}) {
  const order: string[] = [];
  const signer = {
    address: async () => TREASURY,
    sendTransaction: async (_tx: unknown) => {
      order.push('send');
      if (opts.sendThrows) throw new Error('broadcast failed');
      return {
        hash: '0xdeploy',
        wait: async () => {
          order.push('wait');
          return opts.receipt === undefined
            ? { status: 1, contractAddress: SPLITTER, logs: [] }
            : opts.receipt;
        },
      };
    },
  };
  const hooks = {
    onPlanned: async (initcode: string) => {
      order.push(`planned:${initcode.slice(0, 4)}`);
    },
    onSent: async (hash: string) => {
      order.push(`sent:${hash}`);
    },
    onReceipt: async (r: { status: number | null; contractAddress: string | null }) => {
      order.push(`receipt:${r.status}:${r.contractAddress ?? 'null'}`);
    },
  };
  return { order, signer, hooks };
}

const run = (h: ReturnType<typeof harness>) =>
  deploySplitter(h.signer as never, TREASURY, TREASURY, '0x' + '0'.repeat(40), undefined, D, h.hooks);

describe('deploySplitter actually invokes its lifecycle hooks', () => {
  it('records the planned initcode before the transaction can be sent', async () => {
    const h = harness();
    await run(h);
    const planned = h.order.findIndex((s) => s.startsWith('planned:'));
    const send = h.order.indexOf('send');
    expect(planned).toBeGreaterThan(-1);
    expect(planned).toBeLessThan(send);
    // The exact bytes, not a placeholder: a journal row that cannot identify its own
    // payload cannot later be matched against a transaction on the explorer.
    expect(h.order[planned]).toMatch(/^planned:0x/);
  });

  it('binds the hash after send returns and before the receipt is awaited', async () => {
    const h = harness();
    await run(h);
    const sent = h.order.indexOf('sent:0xdeploy');
    const send = h.order.indexOf('send');
    const wait = h.order.indexOf('wait');
    expect(send).toBeLessThan(sent);
    expect(sent).toBeLessThan(wait);
  });

  it('reports the receipt with its contract address', async () => {
    const h = harness();
    await run(h);
    expect(h.order).toContain(`receipt:1:${SPLITTER}`);
  });

  /**
   * The case the caller previously could not see at all. A null receipt is not a revert,
   * and the hook must fire so the journal can keep the row blocking.
   */
  it('reports a null receipt as status null rather than staying silent', async () => {
    const h = harness({ receipt: null });
    await expect(run(h)).rejects.toThrow();
    expect(h.order).toContain('receipt:null:null');
  });

  it('reports a reverted receipt distinctly from a missing one', async () => {
    const h = harness({ receipt: { status: 0, contractAddress: null, logs: [] } });
    await expect(run(h)).rejects.toThrow();
    expect(h.order).toContain('receipt:0:null');
  });

  /** A journal write that fails must stop the lifecycle, not be stepped over. */
  it('does not send when the planned hook fails', async () => {
    const h = harness();
    h.hooks.onPlanned = async () => {
      throw new Error('journal is locked');
    };
    await expect(run(h)).rejects.toThrow(/journal is locked/);
    expect(h.order).not.toContain('send');
  });

  it('does not await the receipt when the sent hook fails', async () => {
    const h = harness();
    h.hooks.onSent = async () => {
      throw new Error('journal is locked');
    };
    await expect(run(h)).rejects.toThrow(/journal is locked/);
    expect(h.order).not.toContain('wait');
  });

  /** No hooks at all is the production path, and it must be unchanged. */
  it('works with no hooks supplied', async () => {
    const h = harness();
    const r = await deploySplitter(h.signer as never, TREASURY, TREASURY, '0x' + '0'.repeat(40), undefined, D);
    expect(r.splitterAddress).toBe(SPLITTER);
    expect(h.order).toEqual(['send', 'wait']);
  });
});
