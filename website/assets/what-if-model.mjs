const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const USD_SCALE = 1_000_000n;
const PRICE_SCALE = 1_000_000_000_000_000_000n;
export const PREVIEW_AUTHORITY = Object.freeze({ executionAuthority: 'NONE_PREVIEW_ONLY', canSign: false, canSend: false, canSwap: false, canClaim: false, isExecutableQuote: false });

export function decimalToScaled(value, scale = PRICE_SCALE) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Invalid decimal value');
  const [whole, fraction = ''] = text.split('.');
  const digits = scale.toString().length - 1;
  return BigInt(whole) * scale + BigInt((fraction + '0'.repeat(digits)).slice(0, digits));
}

const valueMicros = (raw, decimals, priceScaled) => BigInt(raw) * priceScaled * USD_SCALE / ((10n ** BigInt(decimals)) * PRICE_SCALE);

export function calculateWhatIf(input) {
  const wallet = String(input?.wallet || '').toLowerCase();
  const token = String(input?.token || '').toLowerCase();
  if (!ADDRESS.test(wallet)) throw new Error('Invalid wallet address');
  if (!ADDRESS.test(token)) throw new Error('Invalid token address');
  const decimals = Number(input?.tokenDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token decimals');
  if (!input?.tokenPriceUsd || !input?.quotePriceUsd) return { ...PREVIEW_AUTHORITY, state: 'unavailable', reason: 'Current price is unavailable; no counterfactual is calculated.' };

  const tokenPrice = decimalToScaled(input.tokenPriceUsd);
  const quotePrice = decimalToScaled(input.quotePriceUsd);
  if(tokenPrice<=0n||quotePrice<=0n)return {...PREVIEW_AUTHORITY,state:'unavailable',reason:'Current price is unavailable; no counterfactual is calculated.'};
  const trades = Array.isArray(input.trades) ? input.trades : [];
  let totalBought = 0n, totalSold = 0n, spentQuote = 0n, realizedQuote = 0n;
  const seen = new Set();
  for (const trade of trades) {
    const hash = String(trade?.txHash || trade?.transactionHash || '').toLowerCase();
    const logIndex=Number(trade?.logIndex);
    const identity=`${hash}:${Number.isInteger(logIndex)?logIndex:''}`;
    if (!HASH.test(hash) || seen.has(identity)) continue;
    seen.add(identity);
    const tokenRaw = BigInt(trade.walletTokenRaw || '0');
    const quoteRaw = BigInt(trade.quoteRaw || '0');
    if (tokenRaw < 0n || quoteRaw < 0n) throw new Error('Negative trade amount');
    if (trade.kind === 'buy') { totalBought += tokenRaw; spentQuote += quoteRaw; }
    else if (trade.kind === 'sell') { totalSold += tokenRaw; realizedQuote += quoteRaw; }
  }
  const balance = BigInt(input.currentBalanceRaw || '0');
  if (balance < 0n) throw new Error('Negative balance');
  const neverSold = valueMicros(totalBought, decimals, tokenPrice);
  const holdings = valueMicros(balance, decimals, tokenPrice);
  const realized = valueMicros(realizedQuote, 18, quotePrice);
  const actual = holdings + realized;
  return {
    ...PREVIEW_AUTHORITY,
    schema: 'ponsr.what-if',
    state: input.historyComplete === false ? 'partial' : 'complete',
    wallet,
    token,
    totalBoughtRaw: totalBought.toString(),
    totalSoldRaw: totalSold.toString(),
    spentQuoteRaw: spentQuote.toString(),
    realizedQuoteRaw: realizedQuote.toString(),
    currentBalanceRaw: balance.toString(),
    tokenPriceUsd: String(input.tokenPriceUsd),
    quotePriceUsd: String(input.quotePriceUsd),
    neverSoldUsdMicros: neverSold.toString(),
    actualUsdMicros: actual.toString(),
    deltaUsdMicros: (neverSold - actual).toString(),
    tradeCount: seen.size,
    methodology: 'Counterfactual from observed buys/sells, current token price, current token balance, and realized quote proceeds valued at current quote price.',
  };
}

export function usdFromMicros(value) {
  const amount = BigInt(value || 0);
  const sign = amount < 0n ? '−' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / USD_SCALE;
  const cents = ((absolute % USD_SCALE) / 10_000n).toString().padStart(2, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${cents}`;
}
