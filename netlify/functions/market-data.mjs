import snapshot from '../../website/data/launches.json' with { type: 'json' };
import { normaliseMarket } from '../../website/assets/market-model.mjs';
import { collectTransfers, holdersFromTransfers, jsonRpc, parseBlockNumber, resolveVerifiedLaunch } from './lib/collector.mjs';

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
/**
 * Holders and transfers come from the CHAIN, not from the explorer.
 *
 * `robinhoodchain.blockscout.com` is behind Cloudflare and answers a
 * server-side request with 403 and a "Just a moment..." page -- every
 * endpoint, including the legacy `/api`. Those two panels were therefore
 * permanently unavailable while the data itself was perfectly readable one
 * layer down. Reading the token's own Transfer logs answers the same question
 * exactly, and cannot be challenged.
 */
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const RPC_BUDGET_MS=20000;
const json = (body, status = 200, extraHeaders={}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=45, stale-while-revalidate=180', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',...extraHeaders } });
/**
 * GeckoTerminal's free tier rate-limits, and the retry used to be immediate.
 *
 * Measured: repeated calls return HTTP 429, and an instant second attempt hits
 * the same limit -- so a transient throttle became a permanently unavailable
 * range. There is a short backoff between attempts now, longer after a 429.
 * The status is carried on the error so the caller can say WHO refused rather
 * than blaming the data.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = async (url) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Ponsr-market/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        const error = new Error(`provider ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < 2) await sleep(error?.status === 429 ? 900 * (attempt + 1) : 250);
    }
  }
  throw last;
};

export default async (request) => {
  if(request.method!=='GET')return json({schema:'ponsr.market',state:'error',problem:'Method not allowed.'},405,{allow:'GET'});
  const url = new URL(request.url);
  const tokenAddress = String(url.searchParams.get('token') || '').toLowerCase();
  if(!ADDRESS.test(tokenAddress))return json({schema:'ponsr.market',state:'error',problem:'A valid token address is required.'},400);
  const rpcDeadline=Date.now()+RPC_BUDGET_MS;
  const rpc = (method, params) => {const remaining=rpcDeadline-Date.now();if(remaining<=0)throw new Error('RPC request budget exhausted');return jsonRpc(RPC_URL,method,params,Math.min(8000,remaining));};
  let launch=snapshot.launches.find((item)=>String(item.token).toLowerCase()===tokenAddress);
  if(!launch){
    try{const discoveryHead=parseBlockNumber(await rpc('eth_blockNumber',[]));launch=await resolveVerifiedLaunch({rpc,snapshot,token:tokenAddress,head:discoveryHead});}
    catch{return json({schema:'ponsr.market',state:'error',problem:'Current V2 launch discovery is unavailable.'},503);}
  }
  if (!launch?.curve) return json({ schema: 'ponsr.market', state: 'unavailable', problem: 'This exact address is not a verified current-V2 Ponsr launch.' }, 404);
  const curve = String(launch.curve).toLowerCase();
  const observedAt = new Date().toISOString();
  const poolUrl = `${GECKO}/pools/${curve}`;
  /**
   * `aggregate=1`, not 15.
   *
   * At fifteen-minute buckets a token whose whole history is a handful of
   * trades collapses into ONE candle, and the chart needs two points to draw a
   * line -- so the panel read "Insufficient OHLC history" while the provider
   * held usable data. Measured against the live pool: aggregate=15 returns 1
   * candle, aggregate=1 returns 5.
   */
  const [poolResult, candleResult, tradeResult, chainResult] = await Promise.allSettled([
    getJson(poolUrl),
    getJson(`${poolUrl}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=base`),
    getJson(`${poolUrl}/trades?trade_volume_in_usd_greater_than=0`),
    (async () => {
      const head = parseBlockNumber(await rpc('eth_blockNumber', []));
      const from = Number(launch.blockNumber) || 0;
      // One call for the whole history, not thirty-seven.
      //
      // The default 25k chunk turned a ~920k-block span into ~37 sequential
      // eth_getLogs round trips, which overran the function's budget and made
      // every range read as unavailable. This endpoint accepts the full span in
      // a single request -- measured -- and the adaptive halving still covers
      // the case where a node refuses a range that wide.
      const collected = await collectTransfers({ rpc, token: tokenAddress, fromBlock: from, toBlock: head, initialChunk: 2_000_000 });
      if (collected.state !== 'complete') throw new Error(collected.problem || 'transfer range unread');
      const times = new Map();
      for (const block of [...new Set(collected.logs.map((log) => log.blockNumber))].slice(0, 24)) {
        const header = await rpc('eth_getBlockByNumber', [block, false]).catch(() => null);
        if (header?.timestamp) times.set(block, new Date(parseInt(header.timestamp, 16) * 1000).toISOString());
      }
      const transfers = collected.logs.map((log) => ({
        transaction_hash: log.transactionHash,
        from: { hash: `0x${log.topics[1].slice(-40)}` },
        to: { hash: `0x${log.topics[2].slice(-40)}` },
        total: { value: BigInt(log.data === '0x' ? 0 : log.data).toString(), decimals: 18 },
        block_number: parseInt(log.blockNumber, 16),
        timestamp: times.get(log.blockNumber) || null,
      }));
      const holders = holdersFromTransfers(collected.logs);
      return { transfers, holders, holdersCount: holders.length, throughBlock: collected.throughBlock };
    })(),
  ]);
  const chain = chainResult.status === 'fulfilled' ? chainResult.value : null;
  /**
   * A REFUSED PRICE PROVIDER MUST NOT ERASE THE CHAIN.
   *
   * This used to return early the moment the GeckoTerminal pool call failed,
   * which threw away a chain read that had already succeeded: holders and
   * transfers came from the token's own Transfer logs and had nothing to do
   * with the provider, yet they rendered as unavailable whenever the free tier
   * throttled. One source failing may only ever degrade ITS OWN fields.
   *
   * The identity check keeps its hard stop: a pool that is not this curve is
   * wrong data, not missing data, and must never be published.
   */
  const poolOk = poolResult.status === 'fulfilled';
  const attributes = poolOk ? poolResult.value?.data?.attributes || {} : {};
  if (poolOk) {
    const actualCurve = String(attributes.address || '').toLowerCase();
    if (actualCurve !== curve) return json({ schema: 'ponsr.market', state: 'error', problem: 'Provider pool identity did not match the verified curve.' }, 502);
  }
  const candles=candleResult.status==='fulfilled'?candleResult.value?.data?.attributes?.ohlcv_list:null;
  const providerTrades=tradeResult.status==='fulfilled'?tradeResult.value?.data:null;
  const semanticProvider=Number.isFinite(Number(attributes.base_token_price_usd))&&Number(attributes.base_token_price_usd)>0&&Array.isArray(candles)&&Array.isArray(providerTrades);
  const complete = poolOk && semanticProvider && chain !== null;
  return json(normaliseMarket({
    token: launch.token,
    curve,
    state: complete ? 'complete' : 'partial',
    observedAt,
    pool: attributes,
    // `null` for a range that was never read, an array for one that was. The
    // model keeps the two apart so a rejected call cannot be rendered as the
    // number zero. Do not "simplify" these back to `: []`.
    ohlcv: candleResult.status === 'fulfilled' ? candleResult.value?.data?.attributes?.ohlcv_list ?? [] : null,
    trades: tradeResult.status === 'fulfilled' ? tradeResult.value?.data?.map((item) => item.attributes) ?? [] : null,
    transfers: chain ? chain.transfers : null,
    holders: chain ? chain.holders : null,
    // Counted from the transfer set, so it is exact rather than an aggregate
    // taken on trust -- and it is null, never zero, when the range was unread.
    holdersCount: chain ? chain.holdersCount : null,
    problem: complete
      ? null
      : [poolResult, candleResult, tradeResult].some((r) => r.status === 'rejected' && r.reason?.status === 429)
        ? 'The market data provider is rate-limiting this pool right now. Chain-derived holders and transfers are unaffected.'
        : 'One or more market or chain ranges were unavailable.',
  }, launch));
};
