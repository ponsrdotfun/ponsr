/**
 * WHAT THE ESCROW IS HOLDING FOR EACH LAUNCH, RIGHT NOW.
 *
 * The account pages said "Unavailable" in every box: accrued, claimable,
 * queued, paid. All four, on a page 972px tall carrying 115 words. It read as
 * broken rather than as not-yet, and it was neither -- the numbers exist and
 * are public. Measured the day this was written: 0.02052 NVDA waiting for
 * Microduck's splitter, 0.00944 SPCX for NOBI's.
 *
 * WHAT THIS IS, PRECISELY, BECAUSE THE WORDING IS THE PRODUCT
 * ----------------------------------------------------------
 * This is the PUBLIC RECORD of what the deployment's escrow has credited to a
 * launch's fee splitter. It is not "your fees": this endpoint knows nothing
 * about who is asking, and identity does not arrive until an account can be
 * signed in to. Every launch's figures are as public as its contract.
 *
 * `creatorWei` is 95% of the accrued amount because that is what the splitter's
 * own constants divide when someone calls `claimAndSplit` -- not a projection,
 * and not the headline share of trading fees, which is a different number
 * measured further upstream.
 *
 * A read that fails is reported as unavailable for that row. It is never
 * reported as zero: "nothing accrued" and "we could not ask" are different
 * answers, and one of them would tell a creator there is no money waiting.
 */
import snapshot from '../../website/data/launches.json' with { type: 'json' };
import { DEPLOYMENT, jsonRpc } from './lib/collector.mjs';

const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const RPC_BUDGET_MS = 6000;
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * `balanceOfToken(address,address)` on the escrow.
 *
 * Computed, not remembered: the first value written here was wrong, and a wrong
 * selector does not fail loudly -- it calls a different function or falls into a
 * fallback, and returns a number that looks like money.
 */
const BALANCE_OF_TOKEN = '0xf59e38b7';
const word = (address) => String(address).toLowerCase().replace('0x', '').padStart(64, '0');

/** The splitter's own constants, so a share is quoted from the contract that applies it. */
const CREATOR_BPS = 9500n;
const BPS = 10000n;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Fees move when somebody trades, so a short cache is honest and keeps the
      // page quick. `stale-while-revalidate` is deliberately absent: a stale fee
      // figure is the kind a reader would act on.
      'cache-control': 'public, max-age=30',
      ...headers,
    },
  });

export default async () => {
  const observedAt = new Date().toISOString();
  const deadline = Date.now() + RPC_BUDGET_MS;
  const rpc = (method, params) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('RPC request budget exhausted');
    return jsonRpc(RPC_URL, method, params, Math.min(4000, remaining));
  };

  /**
   * One retry, because a shared public endpoint refuses occasionally and a
   * spurious "unavailable" on a money figure costs a reader more than 300ms
   * does. Two attempts, not a loop: a genuine outage should still be reported
   * as one rather than waited out.
   */
  const balanceOf = async (splitter, erc20) => {
    const ask = async () => {
      const raw = await rpc('eth_call', [
        { to: DEPLOYMENT.escrow, data: `${BALANCE_OF_TOKEN}${word(splitter)}${word(erc20)}` },
        'latest',
      ]);
      if (!/^0x[0-9a-f]*$/i.test(String(raw)) || raw === '0x') throw new Error('Malformed balance');
      return BigInt(raw);
    };
    try {
      return await ask();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return ask();
    }
  };

  /**
   * Every balance is asked for AT ONCE, not one after another.
   *
   * Sequential reads divide one deadline into slices, so a single slow call
   * starves the ones behind it -- which is exactly how a run that normally
   * finishes in 1.4s produced one `unavailable` row while the others were fine.
   * This repository has the same lesson written down about the readiness probe:
   * four sequential round trips inside a 5 000 ms budget failed whenever any one
   * of them cost over a second.
   */
  const jobs = [];
  const launches = snapshot.launches.map((launch) => {
    const splitter = String(launch.splitter ?? '');
    const entry = {
      token: launch.token,
      symbol: launch.symbol,
      name: launch.name,
      splitter: ADDRESS.test(splitter) ? splitter : null,
      pairLabel: launch.pairLabel,
      assets: [],
    };

    if (!entry.splitter) {
      // No splitter recorded means no address to ask about -- not a zero balance.
      entry.state = 'unavailable';
      entry.problem = 'This launch has no recorded fee splitter, so no escrow balance can be read.';
      return entry;
    }

    // The launched token and the asset it trades against: fees arrive in both.
    const assets = [
      { role: 'launched token', erc20: launch.token, label: launch.symbol },
      ...(String(launch.pairToken ?? ZERO).toLowerCase() === ZERO
        ? []
        : [{ role: 'pair asset', erc20: launch.pairToken, label: launch.pairLabel }]),
    ];

    for (const asset of assets) {
      const cell = { ...asset, state: 'unavailable', problem: 'The escrow balance could not be read.' };
      entry.assets.push(cell);
      jobs.push(
        balanceOf(entry.splitter, asset.erc20).then(
          (accruedWei) => {
            const creatorWei = (accruedWei * CREATOR_BPS) / BPS;
            cell.state = 'observed';
            delete cell.problem;
            cell.accruedWei = accruedWei.toString();
            cell.creatorWei = creatorWei.toString();
            cell.treasuryWei = (accruedWei - creatorWei).toString();
          },
          () => undefined
        )
      );
    }
    return entry;
  });

  await Promise.all(jobs);
  for (const entry of launches) {
    if (entry.state === 'unavailable') continue;
    entry.state = entry.assets.every((a) => a.state === 'observed') ? 'observed' : 'partial';
  }

  return json({
    schema: 'ponsr.creator-fees',
    version: 1,
    chainId: DEPLOYMENT.chainId,
    deploymentId: DEPLOYMENT.id,
    escrow: DEPLOYMENT.escrow,
    observedAt,
    /**
     * Said plainly in the payload, not only in the page, because a consumer that
     * renders this without reading the docs must still render it honestly.
     */
    scope: 'public-record',
    note: 'Escrow credit per launch fee splitter. Not account-scoped, and not a claim of ownership.',
    creatorShareBps: Number(CREATOR_BPS),
    launches,
  });
};
