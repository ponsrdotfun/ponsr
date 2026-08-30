const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;

const finiteString = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return Number.isFinite(Number(text)) ? text : null;
};
const validTime=(value)=>value===null||value===undefined||Number.isFinite(Date.parse(String(value)));
const sanitiseRows=(raw)=>{
  const ohlcv=Array.isArray(raw?.ohlcv)?raw.ohlcv.flatMap((row)=>Array.isArray(row)&&row.length>=6&&row.slice(0,6).every((value)=>Number.isFinite(Number(value)))?[row.slice(0,6).map(String)]:[]):[];
  const trades=Array.isArray(raw?.trades)?raw.trades.flatMap((trade)=>HASH.test(String(trade?.transactionHash||'').toLowerCase())&&['buy','sell'].includes(trade?.kind)&&(trade?.blockNumber===null||Number.isSafeInteger(Number(trade?.blockNumber)))&&validTime(trade?.blockTimestamp)&&[trade?.fromAmount,trade?.toAmount,trade?.volumeUsd].every((value)=>value===null||finiteString(value)!==null)?[{...trade,transactionHash:String(trade.transactionHash).toLowerCase()}]:[]):[];
  const transfers=Array.isArray(raw?.transfers)?raw.transfers.flatMap((transfer)=>HASH.test(String(transfer?.transactionHash||'').toLowerCase())&&ADDRESS.test(String(transfer?.from||''))&&ADDRESS.test(String(transfer?.to||''))&&/^\d+$/.test(String(transfer?.amountRaw||''))&&Number.isInteger(Number(transfer?.decimals))&&Number(transfer.decimals)>=0&&Number(transfer.decimals)<=255&&Number.isSafeInteger(Number(transfer?.blockNumber))&&validTime(transfer?.blockTimestamp)?[{...transfer,transactionHash:String(transfer.transactionHash).toLowerCase(),from:String(transfer.from).toLowerCase(),to:String(transfer.to).toLowerCase(),amountRaw:String(transfer.amountRaw),decimals:Number(transfer.decimals)}]:[]):[];
  const holders=Array.isArray(raw?.holders)?raw.holders.flatMap((holder)=>ADDRESS.test(String(holder?.address||''))&&/^\d+$/.test(String(holder?.amountRaw||''))?[{address:String(holder.address).toLowerCase(),amountRaw:String(holder.amountRaw)}]:[]):[];
  const clean=Array.isArray(raw?.ohlcv)&&Array.isArray(raw?.trades)&&Array.isArray(raw?.transfers)&&Array.isArray(raw?.holders)&&ohlcv.length===raw.ohlcv.length&&trades.length===raw.trades.length&&transfers.length===raw.transfers.length&&holders.length===raw.holders.length;
  return {ohlcv,trades,transfers,holders,clean};
};

export function normaliseMarket(raw, expected) {
  const token = String(expected?.token || '').toLowerCase();
  const curve = String(expected?.curve || '').toLowerCase();
  if (!ADDRESS.test(token) || !ADDRESS.test(curve)) throw new Error('Verified token and curve are required');
  if (raw?.schema === 'ponsr.market') {
    const returnedToken=String(raw.token||'').toLowerCase(),returnedPool=String(raw.pool||'').toLowerCase();
    if(returnedToken!==token||(returnedPool&&returnedPool!==curve))throw new Error('Market source returned a different token or curve');
    const rows=sanitiseRows(raw);
    const holderCountValid=raw.holdersCount===null||(Number.isSafeInteger(Number(raw.holdersCount))&&Number(raw.holdersCount)>=0);
    const state=['complete','partial','stale','unavailable','error'].includes(raw.state)?raw.state:'unavailable';
    const semanticComplete=state!=='complete'||(returnedPool===curve&&rows.clean&&holderCountValid&&finiteString(raw.priceUsd)!==null);
    return {...raw,...rows,state:semanticComplete?state:'partial',token:returnedToken,pool:returnedPool,
      holdersCount:holderCountValid?raw.holdersCount:null,problem:semanticComplete?raw.problem:'Malformed market payload was downgraded to partial.'};
  }
  // `curve` is the verified expected identity, not evidence that the external
  // provider answered. Only an address actually returned in `pool` is observed.
  const pool = String(raw?.pool?.address || '').toLowerCase();
  if (raw?.state === 'complete' && pool !== curve) throw new Error('Market source returned a different curve');
  const state = ['complete', 'partial', 'stale', 'unavailable', 'error'].includes(raw?.state) ? raw.state : 'unavailable';
  const candleRows = Array.isArray(raw?.ohlcv) ? raw.ohlcv.filter((row) => Array.isArray(row) && row.length >= 6 && row.every((value) => Number.isFinite(Number(value)))).map((row) => row.slice(0, 6).map(String)) : [];
  // GeckoTerminal returns newest-first and may repeat the current bucket. The
  // chart contract is oldest -> newest, with one observation per timestamp.
  // Preserve the first provider row for a duplicate (the newest response), then
  // sort by event time before applying the display bound.
  const candlesByTimestamp = new Map();
  for (const row of candleRows) if (!candlesByTimestamp.has(row[0])) candlesByTimestamp.set(row[0], row);
  const candles = [...candlesByTimestamp.values()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(-96);
  const trades = Array.isArray(raw?.trades) ? raw.trades.slice(0, 50).flatMap((trade) => {
    const hash = String(trade?.tx_hash || trade?.transactionHash || '').toLowerCase();
    const kind = trade?.kind === 'buy' || trade?.kind === 'sell' ? trade.kind : null;
    if (!HASH.test(hash) || !kind) return [];
    return [{
      transactionHash: hash,
      kind,
      blockNumber: Number.isSafeInteger(Number(trade.block_number)) ? Number(trade.block_number) : null,
      blockTimestamp: trade.block_timestamp || null,
      fromAmount: finiteString(trade.from_token_amount),
      toAmount: finiteString(trade.to_token_amount),
      volumeUsd: finiteString(trade.volume_in_usd),
    }];
  }) : [];
  const transfers = Array.isArray(raw?.transfers) ? raw.transfers.slice(0, 50).flatMap((transfer) => {
    const hash = String(transfer?.transaction_hash || '').toLowerCase();
    const from = String(transfer?.from?.hash || '').toLowerCase();
    const to = String(transfer?.to?.hash || '').toLowerCase();
    const amountRaw = String(transfer?.total?.value || transfer?.total?.value_raw || '');
    const decimals = Number(transfer?.total?.decimals ?? 18);
    if (!HASH.test(hash) || !ADDRESS.test(from) || !ADDRESS.test(to) || !/^\d+$/.test(amountRaw) || !Number.isInteger(decimals)) return [];
    return [{ transactionHash: hash, from, to, amountRaw, decimals, blockNumber: Number(transfer.block_number) || null, blockTimestamp: transfer.timestamp || null }];
  }) : [];
  const holders = Array.isArray(raw?.holders) ? raw.holders.slice(0, 50).flatMap((holder) => {
    const address = String(holder?.address?.hash || '').toLowerCase();
    const amountRaw = String(holder?.value || '');
    if (!ADDRESS.test(address) || !/^\d+$/.test(amountRaw)) return [];
    return [{ address, amountRaw }];
  }) : [];
  /**
   * A RANGE THAT COULD NOT BE READ IS NOT AN EMPTY RANGE.
   *
   * Every counter used to come from `array.length`, which is 0 both when a
   * provider returned nothing and when it returned an error. Measured on the
   * deployed preview: the holders call was rejected, and the token page showed
   * "Holders 0" beside a stat reading "Holders Unavailable".
   *
   * The producer now passes `null` for a range it never read and an array for
   * one it did, so the two cases stay distinguishable all the way to the DOM.
   * A genuine empty result keeps its zero, which is a real answer.
   */
  const availabilityOf = (value) => (Array.isArray(value) ? 'complete' : 'unavailable');
  const tx = raw?.pool?.transactions?.h24;
  const txCount = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null);
  const buys = txCount(tx?.buys);
  const sells = txCount(tx?.sells);

  return {
    schema: 'ponsr.market',
    state,
    source: 'GeckoTerminal',
    token,
    pool,
    observedAt: raw?.observedAt || null,
    priceUsd: finiteString(raw?.pool?.base_token_price_usd),
    quotePriceUsd: finiteString(raw?.pool?.quote_token_price_usd),
    fdvUsd: finiteString(raw?.pool?.fdv_usd),
    volume24hUsd: finiteString(raw?.pool?.volume_usd?.h24),
    // Absent h24 figures are unknown, not a quiet 24 hours.
    transactions24h: buys === null || sells === null ? null : { buys, sells },
    ohlcv: candles,
    trades,
    transfers,
    holders,
    availability: {
      ohlcv: availabilityOf(raw?.ohlcv),
      trades: availabilityOf(raw?.trades),
      transfers: availabilityOf(raw?.transfers),
      holders: availabilityOf(raw?.holders),
    },
    // Never inferred from `holders.length`: that list is capped at 50, so a
    // token with more would have published "50 holders" as a fact.
    holdersCount: Number.isFinite(Number(raw?.holdersCount)) && raw?.holdersCount !== null
      ? Math.max(0, Number(raw.holdersCount))
      : null,
    problem: raw?.problem || null,
  };
}
