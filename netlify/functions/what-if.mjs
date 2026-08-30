import snapshot from '../../website/data/launches.json' with { type: 'json' };
import { calculateWhatIf, PREVIEW_AUTHORITY } from '../../website/assets/what-if-model.mjs';
import { collectCurveActivity, collectTransfers, jsonRpc, parseBlockNumber, resolveVerifiedLaunch } from './lib/collector.mjs';

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const RPC_BUDGET_MS=20000;
const lower = (value) => String(value || '').toLowerCase();
const json = (body, status = 200, extraHeaders={}) => new Response(JSON.stringify({ ...PREVIEW_AUTHORITY, ...body }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',...extraHeaders } });
const getJson = async (url) => {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Ponsr-what-if/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`source ${response.status}`);
      return await response.json();
    } catch (error) { last = error; }
  }
  throw last;
};
const balanceOf = async (token, wallet, rpc, head) => {
  const data = `0x70a08231${wallet.slice(2).padStart(64, '0')}`;
  const result = await rpc('eth_call', [{ to: token, data }, `0x${head.toString(16)}`]);
  if (!/^0x[a-fA-F0-9]+$/.test(result || '')) throw new Error('balance unavailable');
  return BigInt(result).toString();
};
const topicAddress=(topic)=>`0x${String(topic||'').slice(-40)}`.toLowerCase();
export function normaliseChainTransfers(logs, token) {
  token=lower(token);
  return logs.map((log)=>{
    const transactionHash=lower(log?.transactionHash),from=topicAddress(log?.topics?.[1]),to=topicAddress(log?.topics?.[2]);
    const logIndex=Number.parseInt(log?.logIndex,16),blockNumber=Number.parseInt(log?.blockNumber,16);
    const amountRaw=BigInt(log?.data==='0x'?0:log?.data||0).toString();
    if(!HASH.test(transactionHash)||!ADDRESS.test(from)||!ADDRESS.test(to)||!Number.isInteger(logIndex)||!Number.isInteger(blockNumber))throw new Error(`Malformed ${token} Transfer log`);
    return {transactionHash,from,to,amountRaw,decimals:18,logIndex,blockNumber,blockTimestamp:null};
  });
}

export function classifyWalletHistory({ wallet, curve, currentBalanceRaw, historyComplete, events, transfers, transactionSenders=new Map() }) {
  wallet = lower(wallet); curve = lower(curve);
  if (!ADDRESS.test(wallet) || !ADDRESS.test(curve) || !historyComplete) return { state: 'unavailable', trades: [], problem: 'Wallet history is incomplete.' };
  let received = 0n, sent = 0n;
  for (const transfer of transfers) {
    if (transfer.from === wallet && transfer.to !== wallet) sent += BigInt(transfer.amountRaw);
    else if (transfer.to === wallet && transfer.from !== wallet) received += BigInt(transfer.amountRaw);
  }
  if (sent > received) return { state: 'unavailable', trades: [], problem: 'Transfer-derived balance is negative.' };
  const transferBalance = received - sent;
  if (transferBalance !== BigInt(currentBalanceRaw)) return { state: 'unavailable', trades: [], transferBalanceRaw: transferBalance.toString(), identityMatched: false, problem: 'Transfer history does not reconcile to current balance.' };

  const trades = [];
  for (const event of events) {
    const hash = lower(event.transactionHash);
    const canonicalWallet=event.kind==='buy'?lower(event.recipient):lower(event.actor);
    if(canonicalWallet!==wallet&&lower(transactionSenders.get(hash))!==wallet)continue;
    const candidates = transfers.filter((transfer) => transfer.transactionHash === hash && transfer.amountRaw === String(event.tokenWei)
      && (event.kind === 'buy' ? transfer.to === wallet : transfer.from === wallet));
    if (candidates.length !== 1) return { state: 'unavailable', trades: [], transferBalanceRaw: transferBalance.toString(), identityMatched: true, problem: 'Canonical curve event did not match exactly one wallet transfer.' };
    trades.push({ kind: event.kind, txHash: hash, logIndex:event.logIndex, blockNumber: event.blockNumber, blockTimestamp: event.blockTimestamp, walletTokenRaw: String(event.tokenWei), quoteRaw: String(event.quoteWei) });
  }
  const tradeBalance=trades.reduce((balance,trade)=>balance+(trade.kind==='buy'?BigInt(trade.walletTokenRaw):-BigInt(trade.walletTokenRaw)),0n);
  if(tradeBalance!==BigInt(currentBalanceRaw))return {state:'unavailable',trades:[],transferBalanceRaw:transferBalance.toString(),identityMatched:true,problem:'Custody transfers prevent an exact buy/sell counterfactual.'};
  return { state: 'complete', trades, transferBalanceRaw: transferBalance.toString(), identityMatched: true };
}

const mergeCanonicalEvents = (prior, fresh) => {
  const byLog = new Map();
  for (const event of [...prior, ...fresh]) byLog.set(`${lower(event.transactionHash)}:${event.logIndex}`, { ...event, transactionHash: lower(event.transactionHash), actor: lower(event.actor), recipient: lower(event.recipient) });
  return [...byLog.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
};

export default async (request) => {
  if(request.method!=='GET')return json({state:'error',problem:'Method not allowed.'},405,{allow:'GET'});
  const url = new URL(request.url);
  const wallet = lower(url.searchParams.get('wallet'));
  const token = lower(url.searchParams.get('token'));
  if (!ADDRESS.test(wallet)) return json({ state: 'error', problem: 'A valid wallet address is required.' }, 400);
  if (!ADDRESS.test(token)) return json({ state: 'error', problem: 'A valid token address is required.' }, 400);
  try {
    const rpcDeadline=Date.now()+RPC_BUDGET_MS;
    const rpc = (method, params) => {const remaining=rpcDeadline-Date.now();if(remaining<=0)throw new Error('RPC request budget exhausted');return jsonRpc(RPC_URL,method,params,Math.min(8000,remaining));};
    const head = parseBlockNumber(await rpc('eth_blockNumber', []));
    const launch=await resolveVerifiedLaunch({rpc,snapshot,token,head});
    if (!launch?.curve) return json({ state: 'unavailable', problem: 'This token is not a verified current-V2 Ponsr launch.' }, 404);
    const curve = lower(launch.curve);
    const overlapFrom = Math.max(Number(launch.blockNumber), Number(launch.activity?.observedThroughBlock || launch.blockNumber) - 128);
    const [rawTransfers, poolPayload, currentBalanceRaw, observed] = await Promise.all([
      collectTransfers({rpc,token,fromBlock:Number(launch.blockNumber),toBlock:head,initialChunk:1500000}),
      getJson(`${GECKO}/pools/${curve}`),
      balanceOf(token, wallet, rpc, head),
      collectCurveActivity({rpc,curve,fromBlock:overlapFrom,toBlock:head,initialChunk:1500000}),
    ]);
    const transferResult={complete:rawTransfers.state==='complete',transfers:normaliseChainTransfers(rawTransfers.logs,token),problem:rawTransfers.problem,throughBlock:rawTransfers.throughBlock};
    const pool = poolPayload?.data?.attributes || {};
    if (lower(pool.address) !== curve) throw new Error('market identity mismatch');
    const events = mergeCanonicalEvents(launch.activity?.events || [], observed.events || []);
    const hashes=[...new Set(events.map((event)=>lower(event.transactionHash)))];
    const transactions=await Promise.all(hashes.map((hash)=>rpc('eth_getTransactionByHash',[hash])));
    const transactionSenders=new Map(hashes.map((hash,index)=>[hash,lower(transactions[index]?.from)]));
    const classified = classifyWalletHistory({ wallet, curve, currentBalanceRaw, historyComplete: transferResult.complete && observed.state === 'complete', events, transfers: transferResult.transfers, transactionSenders });
    if (classified.state !== 'complete') return json({ schema: 'ponsr.what-if', state: 'unavailable', problem: classified.problem || transferResult.problem || observed.problem || 'Canonical wallet reconciliation failed.' }, 200);
    const positivePrice=(value)=>/^\d+(?:\.\d+)?$/.test(String(value||''))&&Number(value)>0;
    return json({
      ...calculateWhatIf({ wallet, token, tokenDecimals: 18, currentBalanceRaw, tokenPriceUsd: pool.base_token_price_usd, quotePriceUsd: pool.quote_token_price_usd, trades: classified.trades, historyComplete: true }),
      observedAt: new Date().toISOString(),
      throughBlock: observed.throughBlock,
      transferBalanceRaw: classified.transferBalanceRaw,
      identityMatched: classified.identityMatched,
      // Every state here is DERIVED from what the call returned. Two of these
      // shipped as the literal 'complete' — a green tick nothing had measured,
      // which would have survived a pool payload carrying no usable price.
      sources: [
        { id: 'canonical-curve-events', state: observed.state },
        { id: 'robinhood-chain-transfer-logs', state: transferResult.complete ? 'complete' : 'partial', throughBlock: transferResult.throughBlock },
        { id: 'geckoterminal-current-price', state: positivePrice(pool.base_token_price_usd) && positivePrice(pool.quote_token_price_usd) ? 'complete' : 'unavailable' },
        { id: 'robinhood-rpc-balance', state: /^\d+$/.test(String(currentBalanceRaw)) ? 'complete' : 'unavailable' },
      ],
      trades: classified.trades,
    });
  } catch {
    return json({ schema: 'ponsr.what-if', state: 'error', problem: 'The read-only wallet history could not be reconciled. No estimate is shown.' }, 502);
  }
};
