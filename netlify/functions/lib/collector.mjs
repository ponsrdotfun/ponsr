// `launchSelector` and `feeWalletWord` describe THIS deployment's calldata, and
// belong beside its address for the same reason everything else here does: a
// superseded factory takes different calldata, and decoding one layout with
// another's offsets yields a plausible address that is not the right one.
export const DEPLOYMENT = Object.freeze({ id: 'pons-v2-current-7ed', chainId: 4663, factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', startBlock: 26841846, ponsrDeployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa', topic: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607' , launchSelector: '0xf35abbcf', feeWalletWord: 8 });
export const CURVE_TOPICS = Object.freeze({
  buy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  sell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
});
export const CURVE_CALLS = Object.freeze({
  getReserves: '0x0902f1ac', realQuoteReserve: '0x4f1f58fd', trackedQuote: '0xca52b0b7',
  graduated: '0xe7c2b772', graduationThreshold: '0x8b0bc501',
});
const hex = (n) => `0x${n.toString(16)}`;
const addressFromTopic = (topic) => `0x${topic.slice(-40)}`;
const addressTopic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const word = (data, n) => {const value=String(data||'');const start=2+n*64,end=2+(n+1)*64;if(!/^0x[0-9a-fA-F]*$/.test(value)||value.length<end)throw new Error('Malformed ABI word');return BigInt(`0x${value.slice(start,end)}`);};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validRange=(fromBlock,toBlock)=>Number.isSafeInteger(fromBlock)&&Number.isSafeInteger(toBlock)&&fromBlock>=0&&toBlock>=fromBlock;
export const parseBlockNumber=(value)=>{if(!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(String(value||'')))throw new Error('Malformed block number');const parsed=Number.parseInt(value,16);if(!Number.isSafeInteger(parsed))throw new Error('Malformed block number');return parsed;};
async function retry(call, attempts = 3) { let last; for (let i=0;i<attempts;i+=1) { try { return await call(); } catch (error) { last=error; if(i+1<attempts) await sleep(60 * (2 ** i)); } } throw last; }
export async function jsonRpc(url, method, params, timeoutMs=8000) { const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)}); if(!response.ok) throw new Error(`RPC HTTP ${response.status}`); const body=await response.json(); if(body.error) throw new Error('RPC request failed'); return body.result; }
export async function collectLaunches({ rpc, fromBlock=DEPLOYMENT.startBlock, toBlock, initialChunk=25000, minChunk=250, maxRetries=3 }) {
 if(!validRange(fromBlock,toBlock))throw new Error('Invalid chain range');
 let cursor=fromBlock, chunk=Math.max(minChunk,initialChunk), logs=[], partial=false, problem=null;
 while(cursor<=toBlock){const end=Math.min(toBlock,cursor+chunk-1);try{const page=await retry(()=>rpc('eth_getLogs',[{address:DEPLOYMENT.factory,fromBlock:hex(cursor),toBlock:hex(end),topics:[DEPLOYMENT.topic,null,null,addressTopic(DEPLOYMENT.ponsrDeployer)]}]),maxRetries);logs.push(...page);cursor=end+1;chunk=Math.min(initialChunk,Math.floor(chunk*1.5));}catch(error){if(chunk>minChunk){chunk=Math.max(minChunk,Math.floor(chunk/2));continue;}partial=true;problem='A bounded chain range could not be read after retries.';break;}}
 return { state: partial?'partial':'complete', throughBlock:cursor-1, logs, problem };
}
async function timestampFor(rpc, blockNumber) { const block=await retry(()=>rpc('eth_getBlockByNumber',[blockNumber,false])); if(!block?.timestamp) return null; return new Date(parseInt(block.timestamp,16)*1000).toISOString(); }

export async function collectCurveActivity({ rpc, curve, fromBlock, toBlock, initialChunk=25000, minChunk=250, maxRetries=3 }) {
  if(!validRange(fromBlock,toBlock))throw new Error('Invalid chain range');
  const requestedFromBlock=fromBlock;let cursor=fromBlock, chunk=Math.max(minChunk,initialChunk), logs=[], partial=false, problem=null;
  while(cursor<=toBlock){const end=Math.min(toBlock,cursor+chunk-1);try{const page=await retry(()=>rpc('eth_getLogs',[{address:curve,fromBlock:hex(cursor),toBlock:hex(end),topics:[[CURVE_TOPICS.buy,CURVE_TOPICS.sell]]}]),maxRetries);logs.push(...page);cursor=end+1;chunk=Math.min(initialChunk,Math.floor(chunk*1.5));}catch(error){if(chunk>minChunk){chunk=Math.max(minChunk,Math.floor(chunk/2));continue;}partial=true;problem='A bounded curve activity range could not be read after retries.';break;}}
  const timestamps=new Map(); const events=[];
  for(const log of logs){const topic=String(log.topics?.[0]||'').toLowerCase();const kind=topic===CURVE_TOPICS.buy?'buy':topic===CURVE_TOPICS.sell?'sell':null;if(!kind)continue;let blockTimestamp=timestamps.get(log.blockNumber);if(blockTimestamp===undefined){blockTimestamp=await timestampFor(rpc,log.blockNumber);timestamps.set(log.blockNumber,blockTimestamp);}events.push({kind,blockNumber:parseInt(log.blockNumber,16),blockTimestamp,transactionHash:log.transactionHash,logIndex:parseInt(log.logIndex,16),actor:addressFromTopic(log.topics[1]),recipient:addressFromTopic(log.topics[2]),quoteWei:word(log.data,kind==='buy'?0:1).toString(),tokenWei:word(log.data,kind==='buy'?1:0).toString(),feeWei:word(log.data,2).toString(),taxWei:word(log.data,3).toString()});}
  events.sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
  return {state:partial?'partial':'complete',fromBlock:requestedFromBlock,throughBlock:cursor-1,events,problem};
}

const TOKEN_CALLS=Object.freeze({name:'0x06fdde03',symbol:'0x95d89b41',logo:'0xfb7f21eb',description:'0x7284e416'});
const abiString=(value,maxLength)=>{const raw=String(value||'');const offset=Number(word(raw,0));if(offset!==32)throw new Error('Malformed ABI string');const length=Number(word(raw,1));if(!Number.isSafeInteger(length)||length<0||length>maxLength)throw new Error('Malformed ABI string');const start=130,end=start+length*2;if(raw.length<end)throw new Error('Malformed ABI string');const bytes=Uint8Array.from(raw.slice(start,end).match(/.{2}/g)?.map((x)=>Number.parseInt(x,16))||[]);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);};
export const trustedTokenLogo=(value)=>{if(!value)return null;try{const url=new URL(String(value));if(url.protocol!=='https:'||url.hostname!=='pbs.twimg.com'||url.username||url.password||url.port||!/^\/media\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname))return null;for(const key of url.searchParams.keys())if(!['format','name'].includes(key))return null;return url.toString();}catch{return null;}};
export async function collectTokenMetadata({rpc,token,blockNumber}) {
  const blockTag=hex(blockNumber),call=(data)=>retry(()=>rpc('eth_call',[{to:token,data},blockTag]));
  const [name,symbol,logo,description]=await Promise.all([call(TOKEN_CALLS.name),call(TOKEN_CALLS.symbol),call(TOKEN_CALLS.logo),call(TOKEN_CALLS.description)]);
  return {state:'complete',name:abiString(name,64),symbol:abiString(symbol,32),logo:trustedTokenLogo(abiString(logo,512)),description:abiString(description,280),observedThroughBlock:blockNumber};
}

/**
 * The pairing asset's own ticker.
 *
 * The launch event carries the pair token's ADDRESS and nothing else, so the
 * feed could only say "approved token" — the single most consequential fact
 * about a launch, published as a shrug. It is what every buyer spends, and the
 * asset's own contract will say what it is called.
 *
 * Nothing here is inferred. An unreadable getter, a bytes32 symbol, or anything
 * outside a plain ticker's shape keeps the generic label: a wrong ticker on a
 * card is a financial claim, and "approved token" is at least true.
 */
const PAIR_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
export async function collectPairSymbol({ rpc, pairToken, blockNumber }) {
  const address = String(pairToken || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) return null;
  try {
    const raw = await retry(() => rpc('eth_call', [{ to: address, data: TOKEN_CALLS.symbol }, hex(blockNumber)]));
    const symbol = abiString(raw, 32).trim();
    return PAIR_SYMBOL.test(symbol) ? symbol : null;
  } catch {
    return null;
  }
}

export async function collectCurveState({ rpc, curve, blockNumber, observedAt }) {
  const blockTag=hex(blockNumber),call=(data)=>retry(()=>rpc('eth_call',[{to:curve,data},blockTag]));
  const [reserves,realQuote,trackedQuote,graduated,threshold]=await Promise.all([
    call(CURVE_CALLS.getReserves),call(CURVE_CALLS.realQuoteReserve),call(CURVE_CALLS.trackedQuote),call(CURVE_CALLS.graduated),call(CURVE_CALLS.graduationThreshold),
  ]);
  return {state:'complete',graduationThreshold:word(threshold,0).toString(),reserves:{state:'observed',observedAt,observedThroughBlock:blockNumber,quoteReserveWei:word(reserves,0).toString(),tokenReserveWei:word(reserves,1).toString(),realQuoteReserveWei:word(realQuote,0).toString(),trackedQuoteWei:word(trackedQuote,0).toString(),graduated:word(graduated,0)!==0n,sourceState:'complete',problem:null}};
}

export async function decodeLaunches(rpc, logs, observedAt) { const out=[]; for(const log of logs){const blockTimestamp=await timestampFor(rpc,log.blockNumber);out.push({chainId:DEPLOYMENT.chainId,deploymentId:DEPLOYMENT.id,factory:DEPLOYMENT.factory,token:addressFromTopic(log.topics[1]),name:'Metadata unavailable',symbol:'UNKNOWN',curve:addressFromTopic(log.topics[2]),splitter:null,deployer:addressFromTopic(log.topics[3]),pairToken:`0x${word(log.data,0).toString(16).padStart(40,'0')}`,pairLabel:word(log.data,0)===0n?'native ETH':'approved token',launchConfigId:Number(word(log.data,1)),graduationThreshold:word(log.data,2).toString(),transactionHash:log.transactionHash,logIndex:parseInt(log.logIndex,16),blockNumber:parseInt(log.blockNumber,16),blockTimestamp,observedAt,reserves:{state:'unavailable',reason:'No verified reserve snapshot is published in this feed.'},liquidity:{state:'unavailable',reason:'No verified liquidity observation is published.'},feeCollection:{state:'untested'}});} return out; }
export async function resolveVerifiedLaunch({rpc,snapshot,token,head}) {
  const exact=String(token||'').toLowerCase(),known=snapshot.launches.find((item)=>String(item.token).toLowerCase()===exact);
  if(known)return known;
  const from=Math.max(DEPLOYMENT.startBlock,Number(snapshot.asOfBlock||DEPLOYMENT.startBlock)-128);
  const observed=await collectLaunches({rpc,fromBlock:from,toBlock:head,initialChunk:1500000});
  if(observed.state!=='complete'){const error=new Error('Current V2 launch discovery is incomplete');error.code='DISCOVERY_INCOMPLETE';throw error;}
  const match=observed.logs.find((log)=>addressFromTopic(log.topics?.[1]||'').toLowerCase()===exact);
  if(!match)return null;
  return (await decodeLaunches(rpc,[match],new Date().toISOString()))[0]||null;
}
export async function fetchPublicGate(url, fallback) { try { const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(3500)}); const body=await response.json(); if(typeof body.publicLaunchEnabled!=='boolean') throw new Error('gate absent'); return {enabled:body.publicLaunchEnabled,checkedAt:new Date().toISOString(),source:url,state:'complete'}; } catch { return {...fallback,state:'stale'}; } }

/**
 * ERC-20 Transfer logs, straight from the chain.
 *
 * WHY THIS EXISTS INSTEAD OF THE BLOCKSCOUT CALLS IT REPLACES
 * ----------------------------------------------------------
 * The holder and transfer panels were fed by `robinhoodchain.blockscout.com`,
 * which sits behind Cloudflare and answers a non-browser request with
 * HTTP 403 and a "Just a moment..." interstitial. Measured on every endpoint,
 * including the legacy `/api` one: the explorer works in a browser and cannot
 * be read by a server. So the panels were permanently unavailable, and the
 * only ways to "fix" that were to forge a browser User-Agent -- evading a bot
 * challenge, which we will not do -- or to stop depending on the indexer.
 *
 * The chain answers the same question exactly and cheaply. For PSTONKS it is
 * seven logs, from which the holder set falls out by arithmetic rather than by
 * trusting a third party's aggregate.
 *
 * Bounded like `collectLaunches`: adaptive chunk, halving on failure, bounded
 * retries, and a `partial` state when a range cannot be read. An unread range
 * is never reported as an empty one.
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function collectTransfers({ rpc, token, fromBlock, toBlock, initialChunk = 25000, minChunk = 250, maxRetries = 3 }) {
  if(!validRange(fromBlock,toBlock))throw new Error('Invalid chain range');
  let cursor = fromBlock, chunk = Math.max(minChunk, initialChunk), logs = [], partial = false, problem = null;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + chunk - 1);
    try {
      const page = await retry(() => rpc('eth_getLogs', [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: hex(cursor), toBlock: hex(end) }]), maxRetries);
      logs.push(...page.filter((log)=>log?.removed!==true));
      cursor = end + 1;
      chunk = Math.min(initialChunk, Math.floor(chunk * 1.5));
    } catch {
      if (chunk > minChunk) { chunk = Math.max(minChunk, Math.floor(chunk / 2)); continue; }
      partial = true; problem = 'A bounded transfer range could not be read after retries.'; break;
    }
  }
  const unique=new Map();
  for(const log of logs){
    if(!Array.isArray(log?.topics)||log.topics.length<3||!/^0x[0-9a-fA-F]{64}$/.test(String(log.data||''))||!/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash||''))||!/^0x[0-9a-fA-F]+$/.test(String(log.logIndex||'')))throw new Error('Malformed Transfer log');
    unique.set(`${String(log.transactionHash).toLowerCase()}:${Number.parseInt(log.logIndex,16)}`,log);
  }
  return { state: partial ? 'partial' : 'complete', throughBlock: cursor - 1, logs:[...unique.values()], problem };
}

/** Balances by address, derived from the transfer set. Exact, not inferred. */
export function holdersFromTransfers(logs) {
  const balances = new Map();
  const move = (address, delta) => balances.set(address, (balances.get(address) ?? 0n) + delta);
  for (const log of logs) {
    if(log?.removed===true||!Array.isArray(log?.topics)||log.topics.length<3||!/^0x[0-9a-fA-F]{64}$/.test(String(log.data||'')))throw new Error('Malformed Transfer log');
    const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
    const value = BigInt(log.data === '0x' ? 0 : log.data);
    move(from, -value);
    move(to, value);
  }
  const zero = `0x${'0'.repeat(40)}`;
  return [...balances.entries()]
    .filter(([address, balance]) => balance > 0n && address !== zero)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([address, balance]) => ({ address: { hash: address }, value: balance.toString() }));
}
