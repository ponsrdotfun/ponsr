const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const site = path.join(root, 'website');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const loadJson = (file) => JSON.parse(read(file));

const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const PSTONKS = '0x7803f37e0Db73105c47D5A5F3D054a0ae47E2199';
const CURVE = '0xD15546882A51423f2A54A93c9224Cf4AB4b11f91';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

test('canonical public snapshot exposes current V2 launches only and includes PSTONKS', () => {
  const feed = loadJson('website/data/launches.json');
  assert.equal(feed.schema, 'ponsr.launch-feed');
  assert.equal(feed.deployment.factory, FACTORY);
  assert.equal(feed.deployment.startBlock, 26841846);
  assert.ok(feed.launches.length > 0);
  assert.ok(feed.launches.every((launch) => launch.factory === FACTORY));
  assert.ok(feed.launches.some((launch) => launch.token === PSTONKS));
  assert.deepEqual(feed.excludedHistory, undefined, 'V1/test history must not enter the public feed');
});

test('PSTONKS canonical deep route is a generated address page with token metadata', () => {
  const route = `website/token/${PSTONKS.toLowerCase()}/index.html`;
  const html = read(route);
  assert.match(html, /<title>PONSR STONKS \(PSTONKS\) — Ponsr<\/title>/);
  // The trailing slash is the point. This page is written as
  // `token/<address>/index.html`, so `/token/<address>` answers 301 and only
  // `/token/<address>/` answers 200 -- and a canonical tag naming a redirect is
  // a canonical pointing away from itself.
  assert.match(html, new RegExp(`<link rel="canonical" href="https://ponsr\\.fun/token/${PSTONKS.toLowerCase()}/"`));
  assert.match(html, /data-ponsr-app/);
});

test('source reducer distinguishes loading, complete, partial, stale, and error without false freshness', async () => {
  const { reduceSourceState } = await import('../assets/data-state.mjs');
  const base = { generatedAt: '2026-08-28T12:00:00.000Z', sources: [{ state: 'complete' }] };
  assert.equal(reduceSourceState({ loading: true }).kind, 'loading');
  assert.equal(reduceSourceState({ feed: base, now: '2026-08-28T12:01:00.000Z' }).kind, 'complete');
  assert.equal(reduceSourceState({ feed: { ...base, sources: [{ state: 'partial' }] }, now: '2026-08-28T12:01:00.000Z' }).kind, 'partial');
  assert.equal(reduceSourceState({ feed: base, now: '2026-08-28T14:01:00.000Z' }).kind, 'stale');
  assert.equal(reduceSourceState({ error: new Error('offline') }).kind, 'error');
});

test('live source outage remains an explicit error while preserving the last-known-good feed', async () => {
  const { publicChainState } = await import('../../netlify/functions/launch-feed.mjs');
  assert.equal(publicChainState('complete'), 'complete');
  assert.equal(publicChainState('partial'), 'partial');
  assert.equal(publicChainState('error'), 'error');
});

test('event time remains unknown when authoritative block time is absent', async () => {
  const { normaliseLaunch } = await import('../assets/feed-model.mjs');
  const launch = normaliseLaunch({ token: PSTONKS, blockNumber: 42, blockTimestamp: null }, '2026-08-28T12:00:00.000Z');
  assert.equal(launch.blockTimestamp, null);
  assert.equal(launch.eventTimeKnown, false);
  assert.notEqual(launch.blockTimestamp, '2026-08-28T12:00:00.000Z');
});

test('hostile metadata is rendered as text and no untrusted innerHTML sink exists', async () => {
  const { setText } = await import('../assets/render.mjs');
  const node = { textContent: '' };
  setText(node, '<img src=x onerror=alert(1)>');
  assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
  const js = walk(path.join(site, 'assets')).filter((file) => /\.(?:m?js)$/.test(file)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
  assert.doesNotMatch(js, /insertAdjacentHTML|document\.write/);
});

test('public launch gate false is preserved and has paused user copy', async () => {
  const { publicGateMessage } = await import('../assets/data-state.mjs');
  assert.match(publicGateMessage(false), /paused/i);
  const feed = loadJson('website/data/launches.json');
  assert.equal(feed.publicGate.enabled, false);
});

test('public UI has no invented market data or V1 Uniswap mechanics', () => {
  const publicText = walk(site)
    .filter((file) => /\.(?:html|m?js|css|json)$/.test(file)
      && !file.includes(`${path.sep}tests${path.sep}`)
      && !file.endsWith(`${path.sep}smoke-test.js`))
    .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(publicText, /Gainers|slot0\(|Uniswap V3|event Swap/i);
  assert.doesNotMatch(publicText, /\+312%/);
  assert.match(publicText, /GeckoTerminal/);
  assert.match(publicText, /Provider estimate · not market cap/i);
  assert.match(publicText, /Reserve data unavailable|Curve reserves/i);
});

test('collector uses bounded adaptive chunks, retries, registry start block, and authoritative timestamps', async () => {
  const { collectLaunches, DEPLOYMENT } = await import('../../netlify/functions/lib/collector.mjs');
  assert.equal(DEPLOYMENT.startBlock, 26841846);
  const ranges = [];
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x199b7c0';
    if (method === 'eth_getLogs') { ranges.push(params[0]); return []; }
    throw new Error(`unexpected ${method}`);
  };
  const result = await collectLaunches({ rpc, fromBlock: 26841846, toBlock: 26842346, initialChunk: 250 });
  assert.equal(result.state, 'complete');
  assert.ok(ranges.length >= 2);
  assert.ok(ranges.every((r) => parseInt(r.toBlock, 16) - parseInt(r.fromBlock, 16) < 250));
  assert.ok(ranges.every((r) => r.topics[3].endsWith('08e01f1b3156a5d8fe42ed47f09df5156e7c74fa')));
  assert.doesNotMatch(read('netlify/functions/lib/collector.mjs'), /Date\.now\(\).*blockTimestamp|blockTimestamp.*Date\.now\(\)/s);
  assert.match(read('netlify/functions/lib/collector.mjs'),/jsonRpc\([^)]*timeoutMs=8000[\s\S]*AbortSignal\.timeout\(timeoutMs\)/);
});

test('RPC transport passes an absolute deadline signal to every request', async () => {
  const { jsonRpc }=await import('../../netlify/functions/lib/collector.mjs');
  const prior=globalThis.fetch;
  let signal;
  globalThis.fetch=async(_url,options)=>{signal=options.signal;throw new Error('SECRET_PROVIDER_URL');};
  try{await assert.rejects(()=>jsonRpc('https://rpc.invalid','eth_chainId',[],25),/SECRET_PROVIDER_URL/);assert.ok(signal instanceof AbortSignal);}
  finally{globalThis.fetch=prior;}
});

test('expensive public functions reject non-GET methods before external work', async()=>{
  const handler=(await import('../../netlify/functions/launch-feed.mjs')).default;
  assert.equal((await handler(new Request('https://local/',{method:'POST'}))).status,405);
});

test('every public chain handler carries one bounded RPC request budget',()=>{
  for(const file of ['launch-feed.mjs','market-data.mjs','what-if.mjs']){
    const source=read(`netlify/functions/${file}`);
    assert.match(source,/RPC_BUDGET_MS\s*=\s*20000/);
    assert.match(source,/rpcDeadline-Date\.now\(\)/);
    assert.match(source,/RPC request budget exhausted/);
  }
});

test('collectors reject malformed heads and dedupe exact Transfer log identities', async()=>{
  const {collectLaunches,collectTransfers,parseBlockNumber,TRANSFER_TOPIC}=await import('../../netlify/functions/lib/collector.mjs');
  assert.equal(parseBlockNumber('0x2a'),42);assert.throws(()=>parseBlockNumber('garbage'),/block/i);assert.throws(()=>parseBlockNumber('0x01'),/block/i);
  await assert.rejects(()=>collectLaunches({rpc:async()=>[],fromBlock:1,toBlock:NaN}),/range/i);
  const token=`0x${'1'.repeat(40)}`,tx=`0x${'a'.repeat(64)}`,topic=(address)=>`0x${'0'.repeat(24)}${address.slice(2)}`;
  const log={transactionHash:tx,logIndex:'0x1',blockNumber:'0x2',topics:[TRANSFER_TOPIC,topic(`0x${'2'.repeat(40)}`),topic(`0x${'3'.repeat(40)}`)],data:`0x${1n.toString(16).padStart(64,'0')}`};
  const result=await collectTransfers({rpc:async()=>[log,log,{...log,removed:true}],token,fromBlock:1,toBlock:2,initialChunk:10});
  assert.equal(result.logs.length,1);
});

test('serverless live feed uses wide adaptive ranges to finish before the function deadline', () => {
  const source=read('netlify/functions/launch-feed.mjs');
  assert.match(source,/SERVERLESS_INITIAL_CHUNK\s*=\s*1500000/);
  assert.match(source,/collectLaunches\(\{[^}]*initialChunk:\s*SERVERLESS_INITIAL_CHUNK/s);
  assert.match(source,/collectCurveActivity\(\{[^}]*initialChunk:\s*SERVERLESS_INITIAL_CHUNK/s);
  assert.match(source,/knownTransactions[\s\S]*unseenLogs[\s\S]*decodeLaunches\(rpc, unseenLogs/);
  assert.match(read('netlify/functions/lib/collector.mjs'),/minChunk=250/);
});

test('verified launch resolver returns known records without RPC and rejects unknown complete scans', async () => {
  const { resolveVerifiedLaunch }=await import('../../netlify/functions/lib/collector.mjs');
  const snapshot=loadJson('website/data/launches.json');
  const known=await resolveVerifiedLaunch({rpc:async()=>{throw new Error('must not call RPC')},snapshot,token:PSTONKS,head:999});
  assert.equal(known.token.toLowerCase(),PSTONKS.toLowerCase());
  const unknown=await resolveVerifiedLaunch({rpc:async(method)=>method==='eth_getLogs'?[]:null,snapshot,token:`0x${'9'.repeat(40)}`,head:snapshot.asOfBlock+10});
  assert.equal(unknown,null);
  await assert.rejects(()=>resolveVerifiedLaunch({rpc:async()=>{throw new Error('range unread')},snapshot,token:`0x${'8'.repeat(40)}`,head:snapshot.asOfBlock+10}),/incomplete/i);
});

test('live feed merge deduplicates PSTONKS and preserves verified snapshot metadata', async () => {
  const { mergeLaunches } = await import('../../netlify/functions/launch-feed.mjs');
  const verified = {
    token: PSTONKS,
    transactionHash: '0xf392c31b4f30eb1b758acc8530e2ba0136b80dd5125f5d5187bbb35dc351b5ce',
    logIndex: 207,
    name: 'PONSR STONKS',
    symbol: 'PSTONKS',
    splitter: '0xF78DC0166665Bc69d0e40fbf735BdA0D049f088a',
  };
  const discovered = {
    ...verified,
    token: PSTONKS.toLowerCase(),
    name: 'Metadata unavailable',
    symbol: 'UNKNOWN',
    splitter: null,
  };
  const merged = mergeLaunches([verified], [discovered]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'PONSR STONKS');
  assert.equal(merged[0].symbol, 'PSTONKS');
  assert.equal(merged[0].splitter, verified.splitter);
  assert.equal(merged[0].logIndex, 207);
  const sibling={...verified,token:`0x${'7'.repeat(40)}`,logIndex:208};
  assert.equal(mergeLaunches([verified],[sibling]).length,2);
});

test('curve activity collector accepts only CurveBuy/CurveSell and decodes exact quote flow', async () => {
  const { collectCurveActivity, CURVE_TOPICS } = await import('../../netlify/functions/lib/collector.mjs');
  assert.equal(CURVE_TOPICS.buy, '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455');
  assert.equal(CURVE_TOPICS.sell, '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df');
  const curve = '0xD15546882A51423f2A54A93c9224Cf4AB4b11f91';
  const buyer = `0x${'0'.repeat(24)}${'1'.repeat(40)}`;
  const recipient = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;
  const words = [10n, 20n, 1n, 0n].map((n) => n.toString(16).padStart(64, '0')).join('');
  const ranges = [];
  const rpc = async (method, params) => {
    if (method === 'eth_getLogs') {
      ranges.push(params[0]);
      return ranges.length === 1 ? [{ address: curve, topics: [CURVE_TOPICS.buy, buyer, recipient], data: `0x${words}`, blockNumber: '0x64', logIndex: '0x3', transactionHash: `0x${'a'.repeat(64)}` }] : [];
    }
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x64' };
    throw new Error(`unexpected ${method}`);
  };
  const result = await collectCurveActivity({ rpc, curve, fromBlock: 100, toBlock: 400, initialChunk: 200 });
  assert.equal(result.state, 'complete');
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    kind: 'buy', blockNumber: 100, blockTimestamp: '1970-01-01T00:01:40.000Z',
    transactionHash: `0x${'a'.repeat(64)}`, logIndex: 3,
    actor: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}`,
    quoteWei: '10', tokenWei: '20', feeWei: '1', taxWei: '0',
  });
  assert.ok(ranges.every((range) => range.address === curve));
  assert.ok(ranges.every((range) => range.topics[0].includes(CURVE_TOPICS.buy) && range.topics[0].includes(CURVE_TOPICS.sell)));
});

test('token metadata is read from exact token getters at one pinned block', async()=>{
  const {collectTokenMetadata}=await import('../../netlify/functions/lib/collector.mjs');
  const encode=(text)=>{const data=Buffer.from(text);const pad=Math.ceil(data.length/32)*64;return `0x${'20'.padStart(64,'0')}${data.length.toString(16).padStart(64,'0')}${data.toString('hex').padEnd(pad,'0')}`;};
  const bySelector={'0x06fdde03':encode('Moon Coin'),'0x95d89b41':encode('MOON'),'0xfb7f21eb':encode('https://pbs.twimg.com/media/AbCd1234.jpg'),'0x7284e416':encode('A community token.')};
  const calls=[];const rpc=async(method,[call,block])=>{calls.push([method,call.data,block]);return bySelector[call.data];};
  const meta=await collectTokenMetadata({rpc,token:`0x${'1'.repeat(40)}`,blockNumber:123});
  assert.deepEqual(meta,{state:'complete',name:'Moon Coin',symbol:'MOON',logo:'https://pbs.twimg.com/media/AbCd1234.jpg',description:'A community token.',observedThroughBlock:123});
  assert.equal(calls.length,4);assert.ok(calls.every(([,selector,block])=>selector in bySelector&&block==='0x7b'));
});

test('curve state collector reads exact reserve getters at one block watermark', async () => {
  const { collectCurveState, CURVE_CALLS } = await import('../../netlify/functions/lib/collector.mjs');
  const calls=[];
  const words=(...values)=>`0x${values.map((value)=>BigInt(value).toString(16).padStart(64,'0')).join('')}`;
  const answers=new Map([
    [CURVE_CALLS.getReserves,words(1685344697858840480n,996828721230956080714724798n)],
    [CURVE_CALLS.realQuoteReserve,words(5344697858840480n)],
    [CURVE_CALLS.trackedQuote,words(5598606380252075n)],
    [CURVE_CALLS.graduated,words(0n)],
    [CURVE_CALLS.graduationThreshold,words(4200000000000000000n)],
  ]);
  const rpc=async(method,params)=>{assert.equal(method,'eth_call');calls.push(params);return answers.get(params[0].data);};
  const result=await collectCurveState({rpc,curve:CURVE,blockNumber:49176249,observedAt:'2026-08-29T13:04:56.000Z'});
  assert.equal(result.state,'complete');
  assert.equal(result.reserves.realQuoteReserveWei,'5344697858840480');
  assert.equal(result.reserves.trackedQuoteWei,'5598606380252075');
  assert.equal(result.graduationThreshold,'4200000000000000000');
  assert.equal(result.reserves.observedThroughBlock,49176249);
  assert.ok(calls.every(([,tag])=>tag==='0x2ee5eb9'));
});

test('an unread curve state preserves prior reserves as partial instead of publishing zero', async () => {
  const { collectCurveState } = await import('../../netlify/functions/lib/collector.mjs');
  await assert.rejects(()=>collectCurveState({rpc:async()=>{throw new Error('unread')},curve:CURVE,blockNumber:123,observedAt:'2026-08-29T00:00:00Z'}));
  const source=read('netlify/functions/launch-feed.mjs');
  assert.match(source,/preserving last-known reserve observation/);
  assert.doesNotMatch(source,/realQuoteReserveWei:\s*['"]0['"]/);
});

test('curve state rejects empty eth_call output instead of publishing zero', async()=>{
  const {collectCurveState}=await import('../../netlify/functions/lib/collector.mjs');
  await assert.rejects(()=>collectCurveState({rpc:async()=> '0x',curve:CURVE,blockNumber:1,observedAt:'x'}),/malformed/i);
});

test('curve freshness is surfaced independently instead of hiding activity failures behind a complete registry', async () => {
  const { curveSource } = await import('../../netlify/functions/launch-feed.mjs');
  const source = curveSource({ curve: CURVE, activity: { sourceState: 'error', observedThroughBlock: 123, problem: 'curve unavailable' } });
  assert.equal(source.state, 'error');
  assert.equal(source.throughBlock, 123);
  assert.match(source.id, new RegExp(CURVE.slice(2, 10), 'i'));
});

test('activity merge deduplicates overlap and keeps curve freshness separate from launch freshness', async () => {
  const { mergeActivity } = await import('../../netlify/functions/launch-feed.mjs');
  const event = { kind: 'buy', blockNumber: 100, logIndex: 3, transactionHash: `0x${'a'.repeat(64)}`, quoteWei: '10' };
  const merged = mergeActivity({ state: 'observed', sourceState: 'stale', observedThroughBlock: 100, curveBuys: 1, curveSells: 0, events: [event] }, { state: 'partial', throughBlock: 200, observedAt: '2026-08-28T00:00:00Z', events: [event], problem: 'bounded range failed' });
  assert.equal(merged.events.length, 1);
  assert.equal(merged.sourceState, 'partial');
  assert.equal(merged.state, 'observed');
  assert.equal(merged.observedThroughBlock, 100);
  assert.equal(merged.attemptedThroughBlock, 200);
  assert.equal(merged.curveBuys, 1);
  assert.equal(merged.curveSells, 0);
});

test('complete activity overlap removes reorged prior events', async()=>{
  const {mergeActivity}=await import('../../netlify/functions/launch-feed.mjs');
  const old={transactionHash:`0x${'a'.repeat(64)}`,logIndex:1,blockNumber:100,kind:'buy'};
  const merged=mergeActivity({events:[old],observedThroughBlock:100},{state:'complete',fromBlock:90,throughBlock:110,events:[],observedAt:'x'});
  assert.deepEqual(merged.events,[]);assert.equal(merged.curveBuys,0);
});

test('empty source manifests cannot report complete', async()=>{
  const {reduceSourceState}=await import('../assets/data-state.mjs');
  assert.equal(reduceSourceState({feed:{generatedAt:new Date().toISOString(),sources:[]}}).kind,'error');
});

test('token page separates external market OHLC from the canonical non-price curve ledger', () => {
  const html = read(`website/token/${PSTONKS.toLowerCase()}/index.html`);
  const ledgerStart = html.indexOf('data-curve-flow-chart');
  const ledgerEnd = html.indexOf('<section class="panel what-if-lab', ledgerStart);
  const ledger = ledgerStart >= 0 ? html.slice(ledgerStart, ledgerEnd > ledgerStart ? ledgerEnd : undefined) : '';
  assert.match(html, /External market layer · GeckoTerminal/i);
  assert.match(html, /data-market-terminal/);
  assert.match(ledger, /Net ETH flow/i);
  assert.match(ledger, /Cumulative quote accounting/i);
  assert.match(ledger, /data-flow-buy-inflow/);
  assert.match(ledger, /data-flow-sell-outflow/);
  assert.match(ledger, /data-flow-net-inflow/);
  assert.match(ledger, /0\.015445 ETH/);
  assert.match(ledger, /0\.009846393619747925 ETH/);
  assert.match(ledger, /Net inflow/i);
  assert.match(ledger, /data-curve-flow-chart/);
  assert.match(ledger, /CurveBuy|BUY/);
  assert.match(ledger, /CurveSell|SELL/);
  assert.match(ledger, /authoritative block time/i);
  assert.match(ledger, /Not token price/i);
  assert.match(ledger, /0\.005598606380252075 ETH/);
  assert.match(html, /Buy \/ Sell <span data-trade-count>/i);
  assert.match(html, /Buy\/Sell rows are canonical CurveBuy and CurveSell events/i);
  assert.match(ledger, /0\.009846393619747925 ETH/);
  assert.doesNotMatch(ledger, /candlestick|OHLC/i);
});

test('Netlify config serves modular CSP-safe assets and canonical SEO files', () => {
  const config = read('netlify.toml');
  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /functions\s*=\s*"netlify\/functions"/);
  for (const file of ['launch-feed.mjs', 'market-data.mjs', 'what-if.mjs']) {
    const source = fs.readFileSync(path.join(root, 'netlify/functions', file), 'utf8');
    assert.match(source, /x-content-type-options[^\n]+nosniff/i);
    assert.match(source, /referrer-policy[^\n]+no-referrer/i);
  }
  assert.ok(fs.existsSync(path.join(site, 'robots.txt')));
  assert.ok(fs.existsSync(path.join(site, 'sitemap.xml')));
  const index = read('website/index.html');
  assert.doesNotMatch(index, /<style[ >]|<script(?![^>]*src=)/);
  assert.match(index, /data-ponsr-app/);
});

/**
 * THE TERMS MUST SEPARATE WHAT WAS OBSERVED FROM WHAT WAS NOT.
 *
 * This asserted the literal words "not been tested end-to-end", which were true
 * until 1 September 2026 and false the moment the owner collected real fees.
 * Pinning the sentence rather than the property is how a disclaimer becomes a
 * stale claim on the one page that may not carry one.
 *
 * The property survives the change: escrow collection is now stated as tested,
 * and the launchpad locker's upstream cut is stated as NOT exercised by that
 * observation -- because the fees collected had accrued from earlier trading, so
 * the resulting share of trading fees is still arithmetic. Both halves are
 * required, and asserting only the first would let the page overclaim.
 */
test('terms separate the escrow collection that was observed from the locker cut that was not', () => {
  const terms = read('website/terms.html');
  assert.match(terms, /native ETH/i);
  assert.match(terms, /escrow/i);

  // What was measured.
  assert.match(terms, /Escrow collection was tested end.to.end/i);
  assert.match(terms, /95\/5 exactly/i);

  // What was not, and must keep being said.
  assert.match(terms, /locker takes its cut upstream/i);
  assert.match(terms, /not exercised by it/i);
  assert.match(terms, /remains arithmetic rather than a measured figure/i);

  // And the distinction that predates both.
  assert.match(terms, /does not mean delivered/i);
});

test('package provides deterministic website test and build commands', () => {
  const pkg = loadJson('package.json');
  assert.ok(pkg.scripts['test:website']);
  assert.ok(pkg.scripts['build:website']);
});

/**
 * EVERY SITEMAP ENTRY MUST NAME A URL THAT IS ACTUALLY SERVED THERE.
 *
 * Measured on the live site before this was written: ten of twelve entries
 * answered 301. `/explore` redirects to `/explore/`, while `/terms` answers 200
 * and `/terms/` redirects the other way -- so the rule is not "always add a
 * slash", it is how the page was WRITTEN. A blanket trailing slash would have
 * broken the two file-backed pages, which is why the build derives it from the
 * layout rather than decreeing it.
 *
 * This asserts the property offline, against the layout on disk, which is the
 * thing that actually decides it. A test that fetched the live site would prove
 * the same point and fail whenever the network did.
 */
test('every sitemap URL corresponds to a file served at exactly that path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  const paths = [...sitemap.matchAll(/<loc>https:[/][/]ponsr[.]fun([^<]*)<[/]loc>/g)].map((m) => m[1]);

  assert.ok(paths.length >= 12, `expected the full route list, saw ${paths.length}`);
  for (const route of paths) {
    // A trailing slash means a directory with an index; no slash means a file.
    const file = route.endsWith('/')
      ? path.join(root, route.slice(1), 'index.html')
      : `${path.join(root, route.slice(1))}.html`;
    assert.ok(fs.existsSync(file), `${route} is listed but ${path.relative(root, file)} does not exist`);
  }

  // Both shapes must be present, so this cannot pass by every route happening
  // to take the same form.
  assert.ok(paths.some((r) => r.endsWith('/')), 'no directory-backed route listed');
  assert.ok(paths.some((r) => !r.endsWith('/') && r !== '/'), 'no file-backed route listed');
});

/**
 * AN INTERNAL LINK MUST NAME THE URL THAT IS SERVED, NOT ONE THAT REDIRECTS.
 *
 * The sitemap and the canonical tags were corrected earlier; the navigation was
 * not, so every "Explore" and "Account" click still cost a 301. Half a job is
 * how a site ends up with three different opinions about its own addresses.
 *
 * The same layout rule decides it: a page written as `terms.html` is served at
 * `/terms`, a directory at `explore/index.html` at `/explore/`. This asserts
 * against the files on disk rather than against a list, so a new page cannot be
 * linked wrongly and still pass.
 */
test('every internal link resolves to a file without a redirect', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const pages = walk(root).filter((f) => f.endsWith('.html') && !f.includes(`${path.sep}tests${path.sep}`));

  const offenders = [];
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const match of html.matchAll(/href="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) {
      const href = match[1];
      if (href.startsWith('//')) continue;
      // Assets are files with extensions and are served exactly as written.
      if (path.extname(href)) continue;
      const asDirectory = path.join(root, href, 'index.html');
      const asFile = `${path.join(root, href)}.html`;
      const servedAsDirectory = fs.existsSync(asDirectory);
      const servedAsFile = fs.existsSync(asFile);
      if (!servedAsDirectory && !servedAsFile) {
        offenders.push(`${path.relative(root, page)} -> ${href} (no such page)`);
      } else if (servedAsDirectory && !href.endsWith('/')) {
        offenders.push(`${path.relative(root, page)} -> ${href} (redirects to ${href}/)`);
      } else if (servedAsFile && href.endsWith('/')) {
        offenders.push(`${path.relative(root, page)} -> ${href} (redirects to ${href.slice(0, -1)})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `internal links that redirect:\n  ${offenders.join('\n  ')}`);
});

/**
 * THE BOARD MUST NOT ATTRIBUTE EVERY TOKEN TO PONSR.
 *
 * Every explore card read "by 0x08e01f…7c74fa". That is the TREASURY, and it is
 * factually the on-chain deployer of every launch — so the field was not false,
 * and that is exactly what made it dangerous. "by" reads as authorship, so three
 * tokens appeared to belong to one anonymous wallet on a product whose pitch is
 * "launch YOUR token".
 *
 * The creator was knowable the whole time: `creator()` on the launch's own
 * splitter, which the fees page already read. It is in the snapshot now, read
 * once at refresh rather than on every page load, because it cannot change for
 * a given splitter.
 */
test('a launch is credited to its creator, and the treasury is named as the sender', () => {
  const feed = loadJson('website/data/launches.json');
  const withSplitter = feed.launches.filter((l) => l.splitter);
  assert.ok(withSplitter.length > 0, 'no launch has a splitter to read a creator from');
  for (const launch of withSplitter) {
    assert.match(String(launch.creator ?? ''), /^0x[0-9a-fA-F]{40}$/, `${launch.symbol} has no creator`);
  }

  // Microduck was launched by the owner through the bot, so its creator is NOT
  // the treasury. If this ever equals the deployer, the read has silently
  // fallen back to the sender and the board is misattributing again.
  const microduck = feed.launches.find((l) => l.symbol === 'MICRODUCK');
  assert.ok(microduck, 'MICRODUCK is missing from the feed');
  assert.notEqual(
    String(microduck.creator).toLowerCase(),
    String(microduck.deployer).toLowerCase(),
    'the creator has collapsed back into the treasury'
  );

  const explore = read('website/explore/index.html');
  assert.match(explore, /class="launchpad-deployer">creator /);
  assert.doesNotMatch(explore, /class="launchpad-deployer">by /, 'the bare "by" attribution is back');

  /**
   * THE CLIENT BUILDS THIS CARD TOO, AND IT REPAINTS OVER THE BUILT ONE.
   *
   * Asserting only the built HTML is how this defect survived being fixed once
   * already: the build script emitted the corrected card and app.mjs overwrote
   * it with the old markup, so the page still read "by 0x08e01f…" while every
   * test passed. Fifty-four CSS classes are emitted by both producers; a check
   * that reads one of them proves nothing about what a visitor sees.
   */
  /**
   * ONE MODEL NOW, SO ONE PLACE TO ASSERT.
   *
   * This used to read the client's own copy of the card, because there were
   * two and they had drifted. There is one -- `website/assets/cards.mjs` --
   * rendered to a string at deploy time and to DOM nodes in the browser, and a
   * separate test renders the same description both ways and requires the
   * results to be identical. Reading it once is stronger, not weaker.
   */
  const cards = read('website/assets/cards.mjs');
  assert.match(cards, /token\.creator\s*\?\s*`creator /, 'the shared card ignores the creator');
  assert.doesNotMatch(cards, /`by \$\{shortAddress/, 'the bare "by" attribution is back');
  // And the client must go through it rather than building its own again.
  const app = read('website/assets/app.mjs');
  assert.match(app, /launchpadCardModel\(/);
  assert.doesNotMatch(app, /element\('p','launchpad-deployer'/, 'the client is building the card itself again');

  // The token page names both, because the treasury really did send it.
  const page = read(`website/token/${microduck.token.toLowerCase()}/index.html`);
  assert.match(page, /Deployed by/);
  assert.match(page, new RegExp(`creator[^<]*<a[^>]*${microduck.creator.slice(2, 10)}`, 'i'));
});

/**
 * A BARE PERCENTAGE UNDER "MARKET CAP UNAVAILABLE" READS AS A PRICE CHANGE.
 *
 * The card rendered `<span>0.00%</span>` directly beneath the market-cap line,
 * with no label anywhere and no accessible name on the `<progress>`. It is
 * bonding-curve progress — the token page has always called it "Curve progress"
 * — and this repository's own rule is that the board hides the 24h change
 * rather than inventing one. An unlabelled 0.00% invents it by adjacency.
 */
test('curve progress is named on the card, on screen and to a screen reader', () => {
  const explore = read('website/explore/index.html');
  assert.match(explore, /class="launchpad-progress"><span>[\d.]+% to graduation<\/span>/);
  assert.match(explore, /<progress[^>]*aria-label="Bonding curve progress to graduation"/);

  // From the shared model, which the client renders rather than reproduces.
  const cards = read('website/assets/cards.mjs');
  assert.match(cards, /\$\{percent\} to graduation/);
  assert.match(cards, /'aria-label': 'Bonding curve progress to graduation'/);
});
