import snapshot from '../../website/data/launches.json' with { type: 'json' };
import { DEPLOYMENT, collectCurveActivity, collectCurveState, collectLaunches, collectTokenMetadata, decodeLaunches, fetchPublicGate, jsonRpc, parseBlockNumber } from './lib/collector.mjs';

const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const STATUS_URL = process.env.PONSR_STATUS_URL || 'https://ponsr-backend.fly.dev/status/core';
const SERVERLESS_INITIAL_CHUNK = 1500000;
const RPC_BUDGET_MS=20000;

const launchKey = (launch) => `${String(launch.transactionHash||'').toLowerCase()}:${Number(launch.logIndex)}`;
const useful = (value) => value !== null && value !== undefined && value !== '' && value !== 'UNKNOWN' && value !== 'Metadata unavailable';
export const publicChainState = (state) => state === 'complete' ? 'complete' : state === 'partial' ? 'partial' : state === 'error' ? 'error' : 'stale';
export const curveSource = (launch) => ({
  id: `curve-activity:${String(launch.curve || '').toLowerCase()}`,
  state: ['complete', 'partial', 'error', 'stale'].includes(launch.activity?.sourceState) ? launch.activity.sourceState : 'stale',
  throughBlock: Number(launch.activity?.observedThroughBlock || launch.blockNumber || 0),
  attemptedThroughBlock: Number(launch.activity?.attemptedThroughBlock || launch.activity?.observedThroughBlock || launch.blockNumber || 0),
  problem: launch.activity?.problem || null,
});
export const curveStateSource = (launch) => ({
  id: `curve-state:${String(launch.curve || '').toLowerCase()}`,
  state: launch.reserves?.sourceState === 'complete' ? 'complete' : 'partial',
  throughBlock: Number(launch.reserves?.observedThroughBlock || 0),
  problem: launch.reserves?.problem || null,
});
export const metadataSource = (launch) => ({
  id: `token-metadata:${String(launch.token || '').toLowerCase()}`,
  state: launch.metadata?.state === 'complete' ? 'complete' : 'partial',
  throughBlock: Number(launch.metadata?.observedThroughBlock || 0),
  problem: launch.metadata?.problem || null,
});

export function mergeActivity(snapshotActivity, observed) {
  const allPrior = Array.isArray(snapshotActivity?.events) ? snapshotActivity.events : [];
  const prior = observed?.state==='complete'&&Number.isFinite(Number(observed?.fromBlock))
    ? allPrior.filter((event)=>Number(event.blockNumber)<Number(observed.fromBlock)) : allPrior;
  const fresh = Array.isArray(observed?.events) ? observed.events : [];
  const byLog = new Map(prior.map((event) => [`${String(event.transactionHash).toLowerCase()}:${event.logIndex}`, event]));
  for (const event of fresh) byLog.set(`${String(event.transactionHash).toLowerCase()}:${event.logIndex}`, event);
  const events = [...byLog.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return {
    ...snapshotActivity,
    state: events.length ? 'observed' : snapshotActivity?.state || 'unavailable',
    sourceState: observed?.state || snapshotActivity?.sourceState || 'stale',
    observedAt: observed?.state === 'complete' ? observed.observedAt : snapshotActivity?.observedAt,
    observedThroughBlock: observed?.state === 'complete'
      ? Math.max(Number(snapshotActivity?.observedThroughBlock || 0), Number(observed?.throughBlock || 0))
      : Number(snapshotActivity?.observedThroughBlock || 0),
    attemptedThroughBlock: Number(observed?.throughBlock || snapshotActivity?.attemptedThroughBlock || snapshotActivity?.observedThroughBlock || 0),
    curveBuys: events.filter((event) => event.kind === 'buy').length,
    curveSells: events.filter((event) => event.kind === 'sell').length,
    events,
    problem: observed?.problem || null,
  };
}

export function mergeLaunches(verifiedLaunches, discoveredLaunches) {
  const byKey = new Map(verifiedLaunches.map((launch) => [launchKey(launch), { ...launch }]));
  for (const discovered of discoveredLaunches) {
    const key = launchKey(discovered);
    const verified = byKey.get(key);
    if (!verified) {
      byKey.set(key, discovered);
      continue;
    }
    const merged = { ...verified };
    for (const [field, value] of Object.entries(discovered)) {
      const weakerObject = value && typeof value === 'object'
        && ['unavailable', 'unknown'].includes(value.state)
        && merged[field] && typeof merged[field] === 'object'
        && !['unavailable', 'unknown'].includes(merged[field].state);
      if (!weakerObject && (useful(value) || !useful(merged[field]))) merged[field] = value;
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

export default async (request) => {
  if(request?.method&&request.method!=='GET')return new Response(JSON.stringify({state:'error',problem:'Method not allowed.'}),{status:405,headers:{allow:'GET','content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  const observedAt = new Date().toISOString();
  const rpcDeadline=Date.now()+RPC_BUDGET_MS;
  const rpc = (method, params) => {const remaining=rpcDeadline-Date.now();if(remaining<=0)throw new Error('RPC request budget exhausted');return jsonRpc(RPC_URL,method,params,Math.min(8000,remaining));};
  let chainSource;
  let discovered = [];

  try {
    const head = parseBlockNumber(await rpc('eth_blockNumber', []));
    const from = Math.max(DEPLOYMENT.startBlock, (snapshot.asOfBlock || DEPLOYMENT.startBlock) - 128);
    chainSource = await collectLaunches({ rpc, fromBlock: from, toBlock: head, initialChunk: SERVERLESS_INITIAL_CHUNK });
    const knownTransactions=new Set(snapshot.launches.map((launch)=>launchKey(launch)));
    const unseenLogs=chainSource.logs.filter((log)=>!knownTransactions.has(`${String(log.transactionHash||'').toLowerCase()}:${Number.parseInt(log.logIndex,16)}`));
    discovered = await decodeLaunches(rpc, unseenLogs, observedAt);
    chainSource = {
      id: 'current-v2-chain',
      state: chainSource.state,
      fromBlock: from,
      throughBlock: chainSource.throughBlock,
      authoritativeTimestamps: true,
      problem: chainSource.problem,
    };
  } catch {
    chainSource = {
      id: 'current-v2-chain',
      state: 'error',
      fromBlock: Math.max(DEPLOYMENT.startBlock, snapshot.asOfBlock - 128),
      throughBlock: snapshot.asOfBlock,
      authoritativeTimestamps: true,
      problem: 'Current V2 source unavailable; serving last-known-good snapshot.',
    };
  }

  const gate = await fetchPublicGate(STATUS_URL, snapshot.publicGate);
  const sourceState = publicChainState(chainSource.state);
  const launches = mergeLaunches(snapshot.launches, discovered);
  const launchesWithActivity = await Promise.all(launches.map(async (launch) => {
    if (!launch.curve || !['complete', 'partial'].includes(chainSource.state)) return launch;
    let withMetadata=launch;
    try {
      const metadata=await collectTokenMetadata({rpc,token:launch.token,blockNumber:chainSource.throughBlock});
      withMetadata={...launch,...metadata,metadata};
    } catch {
      withMetadata={...launch,metadata:{...launch.metadata,state:'partial',problem:'Token metadata getters were unavailable; preserving last-known metadata.'}};
    }
    const overlapFrom = Math.max(Number(launch.blockNumber || DEPLOYMENT.startBlock), Number(launch.activity?.observedThroughBlock || launch.blockNumber || DEPLOYMENT.startBlock) - 128);
    if (overlapFrom > chainSource.throughBlock) return withMetadata;
    let withActivity=withMetadata;
    try {
      const observed = await collectCurveActivity({ rpc, curve: launch.curve, fromBlock: overlapFrom, toBlock: chainSource.throughBlock, initialChunk: SERVERLESS_INITIAL_CHUNK });
      withActivity={...withMetadata,activity:mergeActivity(launch.activity,{...observed,observedAt})};
    } catch {
      withActivity={...withMetadata,activity:{...launch.activity,sourceState:'error',problem:'Curve activity source unavailable; preserving last-known events.'}};
    }
    try {
      const curveState=await collectCurveState({rpc,curve:launch.curve,blockNumber:chainSource.throughBlock,observedAt});
      return {...withActivity,...curveState};
    } catch {
      return {...withActivity,reserves:{...launch.reserves,sourceState:'partial',problem:'Curve state source unavailable; preserving last-known reserve observation.'}};
    }
  }));
  const body = {
    ...snapshot,
    generatedAt: sourceState === 'complete' ? observedAt : snapshot.generatedAt,
    observedAt,
    asOfBlock: chainSource.throughBlock,
    publicGate: gate,
    sources: [
      { ...chainSource, state: sourceState },
      { id: 'ponsr-public-gate', state: gate.state, checkedAt: gate.checkedAt },
      ...launchesWithActivity.filter((launch) => launch.curve).map(curveSource),
      ...launchesWithActivity.filter((launch) => launch.curve).map(curveStateSource),
      ...launchesWithActivity.filter((launch) => launch.token).map(metadataSource),
    ],
    launches: launchesWithActivity,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
};
