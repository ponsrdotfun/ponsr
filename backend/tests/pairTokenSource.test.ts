import { ChainPairTokenSource } from '../src/pairTokenSource';

/**
 * Only the scanning behaviour is tested here; which approval wins and how a symbol
 * resolves live in pairTokens.ts, where they need no node to run. What this file
 * guards is the part that talks to one, and specifically the two ways a log scan
 * quietly lies: by re-reading everything, and by recording a partial read as whole.
 */

function fakeFactory(logsByRange: (lo: number, hi: number) => any[], onQuery?: (lo: number, hi: number) => void) {
  return {
    filters: { PairTokenApprovalUpdated: () => ({}) },
    queryFilter: async (_f: unknown, lo: number, hi: number) => {
      onQuery?.(lo, hi);
      return logsByRange(lo, hi);
    },
  };
}

function log(address: string, approved: boolean, blockNumber: number, index = 0) {
  return { args: [address, approved], blockNumber, index };
}

function build(head: () => number, factory: any, fromBlock = 0, chunkSize = 100) {
  const src = new ChainPairTokenSource({
    provider: { getBlockNumber: async () => head() } as any,
    factoryAddress: '0x' + '11'.repeat(20),
    fromBlock,
    chunkSize,
  });
  (src as any).factory = factory;
  return src;
}

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);

describe('ChainPairTokenSource.approvalHistory', () => {
  it('reads events across chunked windows', async () => {
    const src = build(
      () => 250,
      fakeFactory((lo) => (lo === 100 ? [log(A, true, 150)] : lo === 200 ? [log(B, true, 210)] : []))
    );
    const events = await src.approvalHistory();
    expect(events.map((e) => e.pairToken)).toEqual([A, B]);
    expect(events[0]).toMatchObject({ approved: true, blockNumber: 150, logIndex: 0 });
  });

  // A full scan is ~135 windows against this chain and takes most of a minute.
  // Repeating it hourly would stall the bot to re-learn facts fixed since August.
  it('rescans only the blocks it has not seen', async () => {
    const ranges: Array<[number, number]> = [];
    let head = 250;
    const src = build(
      () => head,
      fakeFactory((lo) => (lo === 100 ? [log(A, true, 150)] : []), (lo, hi) => ranges.push([lo, hi]))
    );

    await src.approvalHistory();
    const firstPass = ranges.length;
    expect(firstPass).toBeGreaterThan(1);

    head = 260;
    ranges.length = 0;
    const second = await src.approvalHistory();
    // Only the new tail, and the earlier event is still there.
    expect(ranges).toEqual([[251, 260]]);
    expect(second.map((e) => e.pairToken)).toEqual([A]);
  });

  it('does no work at all when the head has not moved', async () => {
    const ranges: Array<[number, number]> = [];
    const src = build(() => 250, fakeFactory(() => [], (lo, hi) => ranges.push([lo, hi])));
    await src.approvalHistory();
    ranges.length = 0;
    await src.approvalHistory();
    expect(ranges).toEqual([]);
  });

  it('keeps events found in a later pass alongside the earlier ones', async () => {
    let head = 100;
    const src = build(
      () => head,
      fakeFactory((lo) => (lo === 0 ? [log(A, true, 50)] : lo === 101 ? [log(A, false, 120)] : []))
    );
    await src.approvalHistory();
    head = 200;
    const all = await src.approvalHistory();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ approved: false, blockNumber: 120 });
  });

  // A window that fails must fail the whole read. Silently shortening the history
  // turns an approval pons did grant into an asset the bot refuses forever, which
  // looks exactly like it was never approved.
  it('throws rather than returning a shortened history', async () => {
    const src = build(
      () => 250,
      fakeFactory((lo) => {
        if (lo === 100) throw new Error('range too large');
        return [];
      })
    );
    await expect(src.approvalHistory()).rejects.toThrow(/could not read approvals for blocks 100/);
  });

  // The failed range must not be treated as scanned, or the next pass starts past it
  // and the approval inside is lost for the life of the process.
  it('does not advance its watermark past a failed window', async () => {
    let failing = true;
    const ranges: Array<[number, number]> = [];
    const src = build(
      () => 250,
      fakeFactory(
        (lo) => {
          if (lo === 100 && failing) throw new Error('range too large');
          return lo === 100 ? [log(A, true, 150)] : [];
        },
        (lo, hi) => ranges.push([lo, hi])
      )
    );

    await expect(src.approvalHistory()).rejects.toThrow();
    failing = false;
    ranges.length = 0;
    const events = await src.approvalHistory();
    expect(ranges[0]).toEqual([0, 99]); // started over, not from 250
    expect(events.map((e) => e.pairToken)).toEqual([A]);
  });

  it('ignores a log with no decoded arguments', async () => {
    const src = build(() => 50, fakeFactory(() => [{ blockNumber: 10, index: 0 }]));
    await expect(src.approvalHistory()).resolves.toEqual([]);
  });
});
