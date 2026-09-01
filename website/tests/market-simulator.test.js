const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PSTONKS = '0x7803f37e0db73105c47d5a5f3d054a0ae47e2199';
const CURVE = '0xd15546882a51423f2a54a93c9224cf4ab4b11f91';

test('market normalizer binds GeckoTerminal data to the exact verified curve and explicit source state', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const result = normaliseMarket({
    token: PSTONKS,
    curve: CURVE,
    observedAt: '2026-08-28T10:00:00.000Z',
    pool: { address: CURVE, base_token_price_usd: '0.00000428', quote_token_price_usd: '2510.58', fdv_usd: '4283.78', volume_usd: { h24: '63.51' }, transactions: { h24: { buys: 3, sells: 1 } } },
    ohlcv: [[1787859000, 0.0000042, 0.0000044, 0.0000041, 0.00000428, 63.51]],
    trades: [{ tx_hash: `0x${'a'.repeat(64)}`, kind: 'buy', block_number: 42, block_timestamp: '2026-08-28T09:00:00Z', from_token_amount: '0.01', to_token_amount: '2500000', volume_in_usd: '25.1' }],
    transfers: [{ transaction_hash: `0x${'b'.repeat(64)}`, block_number: 43, timestamp: '2026-08-28T09:01:00Z', from: { hash: `0x${'1'.repeat(40)}` }, to: { hash: `0x${'2'.repeat(40)}` }, total: { value: '2500000000000000000000000', decimals: '18' } }],
    state: 'complete',
  }, { token: PSTONKS, curve: CURVE });
  assert.equal(result.state, 'complete');
  assert.equal(result.pool, CURVE);
  assert.equal(result.priceUsd, '0.00000428');
  assert.equal(result.transactions24h.buys, 3);
  assert.equal(result.ohlcv.length, 1);
  assert.equal(result.trades.length, 1);
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].amountRaw, '2500000000000000000000000');
  assert.throws(() => normaliseMarket({ state: 'complete', pool: { address: `0x${'b'.repeat(40)}` } }, { token: PSTONKS, curve: CURVE }), /curve/i);
});

test('canonical wallet classifier requires curve event, exact transfer amount, and wallet transaction sender', async () => {
  const { classifyWalletHistory } = await import('../../netlify/functions/what-if.mjs');
  const wallet = `0x${'1'.repeat(40)}`;
  const curve = `0x${'2'.repeat(40)}`;
  const tx = `0x${'a'.repeat(64)}`;
  const history = classifyWalletHistory({ wallet, curve, currentBalanceRaw: '20', historyComplete: true,
    events: [{ kind: 'buy', transactionHash: tx, actor: `0x${'3'.repeat(40)}`, recipient: wallet, tokenWei: '20', quoteWei: '10', blockNumber: 5, blockTimestamp: '2026-08-28T00:00:00Z' }],
    transfers: [{ transactionHash: tx, from: curve, to: wallet, amountRaw: '20', decimals: 18, logIndex: 4, blockNumber: 5, blockTimestamp: '2026-08-28T00:00:00Z' }],
  });
  assert.equal(history.state, 'complete');
  assert.equal(history.trades.length, 1);
  assert.equal(history.trades[0].kind, 'buy');
  assert.equal(history.trades[0].walletTokenRaw, '20');
  assert.equal(history.trades[0].quoteRaw, '10');
  assert.equal(history.transferBalanceRaw, '20');
  assert.equal(history.identityMatched, true);
  assert.equal(classifyWalletHistory({ wallet, curve, currentBalanceRaw: '20', historyComplete: true, events: [{kind:'buy',transactionHash:tx,actor:`0x${'3'.repeat(40)}`,recipient:wallet,tokenWei:'20',quoteWei:'10'}], transfers: [{ transactionHash: tx, from: curve, to: wallet, amountRaw: '19', decimals: 18, logIndex: 4 }] }).state, 'unavailable');
});

test('wallet classifier supports same-transaction routed forwarding without weakening identity', async()=>{
  const {classifyWalletHistory}=await import('../../netlify/functions/what-if.mjs');
  const wallet=`0x${'1'.repeat(40)}`,curve=`0x${'2'.repeat(40)}`,router=`0x${'3'.repeat(40)}`,tx=`0x${'a'.repeat(64)}`;
  const result=classifyWalletHistory({wallet,curve,currentBalanceRaw:'20',historyComplete:true,
    events:[{kind:'buy',transactionHash:tx,actor:router,recipient:router,tokenWei:'20',quoteWei:'10',logIndex:1}],
    transfers:[{transactionHash:tx,from:curve,to:router,amountRaw:'20'},{transactionHash:tx,from:router,to:wallet,amountRaw:'20'}],transactionSenders:new Map([[tx,wallet]])});
  assert.equal(result.state,'complete');assert.equal(result.trades.length,1);
  const foreign=classifyWalletHistory({wallet,curve,currentBalanceRaw:'20',historyComplete:true,events:[{kind:'buy',transactionHash:tx,actor:router,recipient:router,tokenWei:'20',quoteWei:'10'}],transfers:[{transactionHash:tx,from:router,to:wallet,amountRaw:'20'}],transactionSenders:new Map([[tx,router]])});
  assert.equal(foreign.trades.length,0);
});

test('What-if model uses fixed-point integer math for actual versus never-sold value', async () => {
  const { calculateWhatIf } = await import('../assets/what-if-model.mjs');
  const result = calculateWhatIf({
    wallet: `0x${'1'.repeat(40)}`,
    token: PSTONKS,
    tokenDecimals: 18,
    currentBalanceRaw: '2000000000000000000000000',
    tokenPriceUsd: '0.00000425',
    quotePriceUsd: '2500.50',
    trades: [
      { kind: 'buy', walletTokenRaw: '3000000000000000000000000', quoteRaw: '10000000000000000', txHash: `0x${'a'.repeat(64)}` },
      { kind: 'buy', walletTokenRaw: '1000000000000000000000000', quoteRaw: '4000000000000000', txHash: `0x${'b'.repeat(64)}` },
      { kind: 'sell', walletTokenRaw: '2000000000000000000000000', quoteRaw: '9000000000000000', txHash: `0x${'c'.repeat(64)}` },
    ],
  });
  assert.equal(result.totalBoughtRaw, '4000000000000000000000000');
  assert.equal(result.currentBalanceRaw, '2000000000000000000000000');
  assert.equal(result.realizedQuoteRaw, '9000000000000000');
  assert.equal(result.neverSoldUsdMicros, '17000000');
  assert.equal(result.actualUsdMicros, '31004500');
  assert.equal(result.deltaUsdMicros, '-14004500');
  assert.equal(result.state, 'complete');
  assert.equal(result.executionAuthority, 'NONE_PREVIEW_ONLY');
  assert.equal(result.canSign, false);
  assert.equal(result.canSend, false);
  assert.equal(result.canSwap, false);
  assert.equal(result.canClaim, false);
  assert.equal(result.isExecutableQuote, false);
});

test('What-if counts distinct canonical logs in the same transaction', async()=>{
  const {calculateWhatIf}=await import('../assets/what-if-model.mjs');
  const tx=`0x${'a'.repeat(64)}`;
  const result=calculateWhatIf({wallet:`0x${'1'.repeat(40)}`,token:PSTONKS,tokenDecimals:18,currentBalanceRaw:'3',tokenPriceUsd:'1',quotePriceUsd:'1',historyComplete:true,trades:[
    {kind:'buy',txHash:tx,logIndex:1,walletTokenRaw:'1',quoteRaw:'1'},
    {kind:'buy',txHash:tx,logIndex:2,walletTokenRaw:'2',quoteRaw:'2'},
  ]});
  assert.equal(result.tradeCount,2);assert.equal(result.totalBoughtRaw,'3');
});

test('What-if model fails closed for missing price, malformed wallet, and incomplete history', async () => {
  const { calculateWhatIf } = await import('../assets/what-if-model.mjs');
  const base = { wallet: `0x${'1'.repeat(40)}`, token: PSTONKS, tokenDecimals: 18, currentBalanceRaw: '0', tokenPriceUsd: null, quotePriceUsd: null, trades: [] };
  assert.equal(calculateWhatIf(base).state, 'unavailable');
  assert.throws(() => calculateWhatIf({ ...base, wallet: '0x123' }), /wallet/i);
  assert.equal(calculateWhatIf({ ...base, tokenPriceUsd: '1', quotePriceUsd: '1', historyComplete: false }).state, 'partial');
});

test('website wallet integration is read-only and exposes no signing or chain-mutation path', () => {
  const app = read('website/assets/app.mjs');
  const simulator = read('website/assets/what-if-model.mjs');
  const publicJs = `${app}\n${simulator}`;
  assert.match(publicJs, /eth_requestAccounts/);
  assert.doesNotMatch(publicJs, /eth_sendTransaction|personal_sign|eth_sign|wallet_switchEthereumChain|wallet_addEthereumChain|sendTransaction\(|signer|privateKey/i);
  const html = read(`website/token/${PSTONKS}/index.html`);
  assert.match(html, /data-what-if-simulator/);
  assert.match(html, /Read-only/i);
});

/**
 * A LOCAL CHAIN, SO "NOT FOUND" IS NOT A STATEMENT ABOUT THE NETWORK.
 *
 * This suite asserted that an unknown token answers 404. Reaching that answer
 * requires discovery to SUCCEED and find nothing -- a token outside the snapshot
 * triggers a real `eth_getLogs` sweep, and when that sweep fails the handler
 * correctly says 503, because "we could not ask" is not "it does not exist".
 *
 * The handler was right and the test was wrong. It passed on a laptop and failed
 * on GitHub's runners, where the public endpoint is slow or refused: 503 !== 404
 * after 21.9 seconds. A test whose verdict depends on whether a third party
 * answers is not testing this repository.
 *
 * So the chain is local here, and it can be switched from answering to refusing
 * mid-test. That is the distinction the handler exists to make, and it can now
 * be asserted in both directions offline. Modelled on `rpcPoolTransport.test.ts`:
 * a real server on a real port, never a stub above the layer under test.
 *
 * The refusal is a flag rather than a per-token rule, because discovery sweeps
 * for ALL launches in a range and matches the token locally -- the address never
 * reaches the log filter, so a server cannot tell which token is being sought.
 */
const http = require('node:http');


/**
 * The head is derived from the committed snapshot, not written down.
 *
 * Discovery sweeps from just before `asOfBlock` up to the head. A head BELOW
 * that start makes the sweep incomplete, which the handler reports as 503 -- so
 * a hardcoded number would quietly stop testing the 404 path the first time the
 * snapshot moved past it.
 */
const HEAD = `0x${(Number(require('../data/launches.json').asOfBlock) + 32).toString(16)}`;

function localChain() {
  const state = { refusing: false };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let call = {};
        try { call = JSON.parse(body); } catch { /* answered as unknown below */ }
        const send = (payload) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id ?? 1, ...payload }));
        };
        if (call.method === 'eth_blockNumber') return send({ result: HEAD });
        if (call.method === 'eth_getLogs') {
          if (state.refusing) return send({ error: { code: -32000, message: 'log range unavailable' } });
          return send({ result: [] });
        }
        return send({ result: '0x' });
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

test('server adapters whitelist verified launch identities and bound external calls', async () => {
  const market = read('netlify/functions/market-data.mjs');
  const simulator = read('netlify/functions/what-if.mjs');
  assert.match(market, /api\.geckoterminal\.com\/api\/v2\/networks\/robinhood/);
  assert.doesNotMatch(simulator, /blockscout/i);
  assert.match(simulator, /collectTransfers/);
  assert.match(simulator, /robinhood-chain-transfer-logs/);
  assert.match(simulator, /balanceOf\(token, wallet, rpc, head\)/);
  assert.match(simulator, /eth_call/);
  assert.match(market + simulator, /AbortSignal\.timeout/);
  assert.match(market + simulator, /resolveVerifiedLaunch/);
  assert.doesNotMatch(market + simulator, /eth_sendRawTransaction|eth_sendTransaction|private.key|privateKey/i);
  // Set before the first import: the modules read the endpoint into a const at
  // load time, so a later assignment would be ignored in silence.
  const chain = await localChain();
  process.env.ROBINHOOD_RPC_URL = chain.url;
  const marketHandler = (await import('../../netlify/functions/market-data.mjs')).default;
  const whatIfHandler = (await import('../../netlify/functions/what-if.mjs')).default;
  const unknown = `0x${'9'.repeat(40)}`;
  try {
    // Asked, and found nothing.
    assert.equal((await marketHandler(new Request(`https://local/?token=${unknown}`))).status, 404);
    // Could not ask. The same request shape, a different answer, and the reason
    // it must never collapse into the one above: a reader told "not found" about
    // their own launch would conclude it does not exist.
    chain.state.refusing = true;
    const unswept = await marketHandler(new Request(`https://local/?token=${unknown}`));
    chain.state.refusing = false;
    assert.equal(unswept.status, 503);
    assert.match((await unswept.json()).problem, /unavailable/i);
  assert.equal((await whatIfHandler(new Request(`https://local/?token=${PSTONKS}&wallet=0x123`))).status, 400);
  assert.equal((await marketHandler(new Request('https://local/?token=garbage'))).status, 400);
  assert.equal((await whatIfHandler(new Request(`https://local/?token=garbage&wallet=0x${'1'.repeat(40)}`))).status, 400);
  const marketMethod=await marketHandler(new Request(`https://local/?token=${PSTONKS}`,{method:'POST'}));
  const whatIfMethod=await whatIfHandler(new Request(`https://local/?token=${PSTONKS}&wallet=0x${'1'.repeat(40)}`,{method:'POST'}));
    assert.equal(marketMethod.status,405);assert.equal(marketMethod.headers.get('allow'),'GET');
    assert.equal(whatIfMethod.status,405);assert.equal(whatIfMethod.headers.get('allow'),'GET');
  } finally {
    chain.server.close();
    delete process.env.ROBINHOOD_RPC_URL;
  }
});

test('What-if normalises exact chain Transfer logs without inventing timestamps', async () => {
  const { normaliseChainTransfers } = await import('../../netlify/functions/what-if.mjs');
  const token=PSTONKS,wallet=`0x${'1'.repeat(40)}`,curve=`0x${'2'.repeat(40)}`,tx=`0x${'a'.repeat(64)}`;
  const topic=(address)=>`0x${'0'.repeat(24)}${address.slice(2)}`;
  const result=normaliseChainTransfers([{transactionHash:tx,logIndex:'0x4',blockNumber:'0x5',topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(curve),topic(wallet)],data:`0x${20n.toString(16).padStart(64,'0')}`}],token);
  assert.deepEqual(result,[{transactionHash:tx,from:curve,to:wallet,amountRaw:'20',decimals:18,logIndex:4,blockNumber:5,blockTimestamp:null}]);
});

test('quant-grade motion restores the exact production articulated mascot and environmental choreography', () => {
  const css = read('website/assets/site.css');
  const app = read('website/assets/app.mjs');
  const html = read('website/index.html');
  assert.match(css, /@keyframes\s+(?:auroraDrift|starDrift|gridTravel)/);
  // Pinned by VALUE, not by name. `botFloatLuxury` used to be asserted here,
  // and because it sat later in the sheet it overrode the real float -- the
  // shipped mascot only moved up and down. Production's motion carries rotation
  // and a scale swell, so those are what the test now requires.
  assert.match(css, /@keyframes\s+botFloat/);
  assert.match(css, /animation:\s*botFloat\s+5\.5s/);
  assert.match(css, /@keyframes botFloat\s*\{[\s\S]*?rotate\(-1\.6deg\)[\s\S]*?\}/);
  assert.match(css, /@keyframes botFloat\s*\{[\s\S]*?scale\(1\.015\)[\s\S]*?\}/);
  assert.doesNotMatch(css, /animation:\s*botFloatLuxury/, 'nothing may override the mascot float again');
  assert.match(css, /@keyframes\s+moteRise/);
  assert.match(css, /\.motion-mote/);
  assert.match(html, /data-bot-tilt/);
  assert.match(app, /createMotionChannel/);
  assert.match(app, /animation\.effect\.setKeyframes\(\[from,keyframe\]\)/);
  assert.match(app, /animation\.currentTime=0;animation\.play\(\)/);
  assert.match(app, /maxX=avatar\.offsetWidth\*\.040/);
  assert.match(app, /maxY=avatar\.offsetWidth\*\.032/);
  assert.match(app, /pull=Math\.min\(1,distance\/380\)/);
  assert.match(app, /eyeState=eyes\.map\(\(eye\)=>\{const rect=eye\.getBoundingClientRect\(\)/);
  // The gaze must be TIGHT. It ran through a 140ms channel, so the pupils
  // visibly trailed the cursor; production applies the move on the same frame.
  // Pinned as a bound, not a magic number.
  const gaze = app.match(/createMotionChannel\(eye,(\d+)\)/);
  assert.ok(gaze, 'the gaze must run through a motion channel');
  assert.ok(Number(gaze[1]) <= 80, `gaze channel is ${gaze[1]}ms; it must stay under 80ms`);
  assert.match(app, /botRect\.bottom<-120\|\|botRect\.top>window\.innerHeight\+120/, 'the gaze must stop when the robot is off-screen');
  assert.match(app, /translate\(calc\(-50% \+ \$\{ex\.toFixed\(2\)\}px\),calc\(-50% \+ \$\{ey\.toFixed\(2\)\}px\)\)/);
  assert.doesNotMatch(app, /if\(reduceMotion\|\|!window\.matchMedia\('\(pointer: fine\)'\)\.matches\)return;[\s\S]{0,240}data-bot-avatar/);
  assert.doesNotMatch(app, /moveTilt|rotateY\([^)]*(?:\.45|11)/);
  // The float must carry translate AND rotation: a flat bob was what shipped.
  assert.match(css, /@keyframes botFloat\s*\{[^}]*translate3d[^}]*\}/s);
  assert.match(css, /@keyframes botFloat\s*\{[\s\S]*?rotate\([^)]*deg\)/s);
  assert.match(html, /data-scroll-progress/);
  assert.match(css, /animation-timeline:\s*scroll\(root block\)/);
  assert.match(html, /data-motion-field/);
  assert.match(html, /logo-noeyes\.png/);
  assert.match(html + css + app, /bot-eyes|eye-l|eye-r/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

/* --------------------------------------------------------------------------
 * A FAILED PROVIDER RANGE IS NOT THE NUMBER ZERO.
 *
 * Measured on the deploy preview at b6f511d: `market-data` answered
 * state `partial` because the Blockscout holders call was REJECTED, and the
 * token page rendered "Holders 0", "Trades 0" and "Transfers 0" next to a
 * stat that simultaneously read "Holders Unavailable" — one page, two answers,
 * one of them invented.
 *
 * The cause is that every counter came from `array.length`, which is 0 both
 * when a range is genuinely empty and when it could not be read. This is the
 * same defect this project has hit repeatedly under a different name: a
 * missing input treated as a permissive value.
 * -------------------------------------------------------------------------- */

test('custody transfers make the counterfactual unavailable instead of inventing a sale loss', async()=>{
  const {classifyWalletHistory}=await import('../../netlify/functions/what-if.mjs');
  const wallet=`0x${'1'.repeat(40)}`,curve=`0x${'2'.repeat(40)}`,tx=`0x${'a'.repeat(64)}`,gift=`0x${'b'.repeat(64)}`;
  const result=classifyWalletHistory({wallet,curve,currentBalanceRaw:'0',historyComplete:true,events:[{kind:'buy',transactionHash:tx,recipient:wallet,actor:wallet,tokenWei:'20',quoteWei:'10'}],transfers:[{transactionHash:tx,from:curve,to:wallet,amountRaw:'20'},{transactionHash:gift,from:wallet,to:`0x${'3'.repeat(40)}`,amountRaw:'20'}]});
  assert.equal(result.state,'unavailable');assert.match(result.problem,/Custody transfers/i);
});

test('zero current prices cannot produce a complete zero-dollar valuation', async()=>{
  const {calculateWhatIf}=await import('../assets/what-if-model.mjs');
  assert.equal(calculateWhatIf({wallet:`0x${'1'.repeat(40)}`,token:PSTONKS,tokenDecimals:18,currentBalanceRaw:'0',tokenPriceUsd:'0',quotePriceUsd:'1',trades:[]}).state,'unavailable');
});

test('an unreadable provider range stays unknown instead of collapsing to zero', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const expected = { token: PSTONKS, curve: CURVE };
  const base = {
    token: PSTONKS,
    curve: CURVE,
    state: 'partial',
    observedAt: '2026-08-28T10:00:00.000Z',
    pool: { address: CURVE, base_token_price_usd: '0.00000428', quote_token_price_usd: '2510.58' },
  };

  // Ranges the provider never returned.
  const unread = normaliseMarket({ ...base, holders: null, transfers: null, trades: null, holdersCount: null }, expected);
  assert.equal(unread.holdersCount, null, 'an unread holder count must not become a number');
  assert.equal(unread.availability.holders, 'unavailable');
  assert.equal(unread.availability.transfers, 'unavailable');
  assert.equal(unread.availability.trades, 'unavailable');

  // Ranges the provider returned, and they were genuinely empty. Zero is a
  // real answer here and must survive as one.
  const empty = normaliseMarket({ ...base, holders: [], transfers: [], trades: [], holdersCount: 0 }, expected);
  assert.equal(empty.holdersCount, 0, 'a real zero must not be replaced');
  assert.equal(empty.availability.holders, 'complete');
  assert.equal(empty.availability.transfers, 'complete');
  assert.equal(empty.availability.trades, 'complete');
});

test('a holder count is never inferred from the truncated holder page', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  // The holder list is capped at 50. Deriving the count from its length would
  // publish "50 holders" for any token with more than fifty.
  const holders = Array.from({ length: 60 }, (_, index) => ({
    address: { hash: `0x${String(index).padStart(40, '0')}` },
    value: '1000',
  }));
  const result = normaliseMarket(
    { token: PSTONKS, curve: CURVE, state: 'partial', pool: { address: CURVE }, holders, holdersCount: null },
    { token: PSTONKS, curve: CURVE }
  );
  assert.equal(result.holders.length, 50, 'the list is still capped');
  assert.equal(result.holdersCount, null, 'the count must not be inferred from a capped list');
});

test('unknown 24h transaction counts stay unknown', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const expected = { token: PSTONKS, curve: CURVE };
  const missing = normaliseMarket({ token: PSTONKS, curve: CURVE, state: 'partial', pool: { address: CURVE } }, expected);
  assert.equal(missing.transactions24h, null, 'absent h24 counts must not read as zero activity');

  const present = normaliseMarket(
    { token: PSTONKS, curve: CURVE, state: 'complete', pool: { address: CURVE, transactions: { h24: { buys: 3, sells: 1 } } } },
    expected
  );
  assert.deepEqual(present.transactions24h, { buys: 3, sells: 1 });
});

test('browser rejects malformed server-shaped market payloads as complete', async()=>{
  const {normaliseMarket}=await import('../assets/market-model.mjs');
  const malformedContainer=normaliseMarket({schema:'ponsr.market',state:'complete',token:PSTONKS,pool:CURVE,priceUsd:'1',ohlcv:{oops:true},trades:[],transfers:[],holders:[],holdersCount:'banana'},{token:PSTONKS,curve:CURVE});
  assert.equal(malformedContainer.state,'partial');assert.deepEqual(malformedContainer.ohlcv,[]);assert.equal(malformedContainer.holdersCount,null);

  const malformedRows=normaliseMarket({
    schema:'ponsr.market',state:'complete',token:PSTONKS,pool:CURVE,priceUsd:'1',
    ohlcv:[['bad']],trades:[{}],
    transfers:[{transactionHash:'bad',from:'bad',to:'bad',amountRaw:'banana',decimals:18}],
    holders:[{address:'bad',amountRaw:'banana'}],holdersCount:1,
  },{token:PSTONKS,curve:CURVE});
  assert.equal(malformedRows.state,'partial');
  assert.deepEqual(malformedRows.ohlcv,[]);assert.deepEqual(malformedRows.trades,[]);
  assert.deepEqual(malformedRows.transfers,[]);assert.deepEqual(malformedRows.holders,[]);
  assert.doesNotThrow(()=>malformedRows.holders.reduce((sum,row)=>sum+BigInt(row.amountRaw),0n));
});

test('the what-if response reports only source states it actually measured', () => {
  const source = read('netlify/functions/what-if.mjs');
  // Two sources shipped as a hardcoded literal `state: 'complete'`, which is a
  // green tick nothing observed.
  assert.doesNotMatch(
    source,
    /id:\s*'geckoterminal-current-price'\s*,\s*state:\s*'complete'/,
    'the price source state must be derived, not asserted'
  );
  assert.doesNotMatch(
    source,
    /id:\s*'robinhood-rpc-balance'\s*,\s*state:\s*'complete'/,
    'the balance source state must be derived, not asserted'
  );
});

/* --------------------------------------------------------------------------
 * ONE SOURCE FAILING MAY ONLY DEGRADE ITS OWN FIELDS.
 *
 * Measured on the deployed preview: GeckoTerminal rate-limited the pool call,
 * the function returned early, and the token page reported holders and
 * transfers as unavailable -- even though those come from the token's own
 * Transfer logs and had already been read successfully. A price provider's
 * throttle was erasing chain data it has nothing to do with.
 * -------------------------------------------------------------------------- */

test('a refused price provider does not erase chain-derived holders and transfers', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const expected = { token: PSTONKS, curve: CURVE };

  // Pool refused: no price, no FDV, no candles -- but the chain ranges stand.
  const degraded = normaliseMarket({
    token: PSTONKS,
    curve: CURVE,
    state: 'partial',
    observedAt: '2026-08-28T21:00:00.000Z',
    pool: {},
    ohlcv: null,
    trades: null,
    holders: [{ address: { hash: `0x${'1'.repeat(40)}` }, value: '5' }],
    transfers: [],
    holdersCount: 1,
    problem: 'rate limited',
  }, expected);

  assert.equal(degraded.availability.ohlcv, 'unavailable');
  assert.equal(degraded.availability.trades, 'unavailable');
  assert.equal(degraded.availability.holders, 'complete', 'a chain read must survive a provider refusal');
  assert.equal(degraded.availability.transfers, 'complete');
  assert.equal(degraded.holdersCount, 1);
  assert.equal(degraded.priceUsd, null, 'no price may be invented when the pool was not read');
  assert.equal(degraded.fdvUsd, null);
});

test('the market function never returns before publishing a successful chain read', () => {
  const source = read('netlify/functions/market-data.mjs');
  // The early return on a rejected pool call is what discarded the chain read.
  assert.doesNotMatch(
    source,
    /if \(poolResult\.status === 'rejected'\) return/,
    'a rejected pool call must degrade its own fields, not end the response'
  );
  // The identity mismatch keeps its hard stop: wrong data, not missing data.
  assert.match(source, /Provider pool identity did not match the verified curve/);
});

test('a server-normalised partial response survives the browser identity boundary', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const expected = { token: PSTONKS, curve: CURVE };
  const server = normaliseMarket({
    token: PSTONKS,
    curve: CURVE,
    state: 'partial',
    pool: {},
    ohlcv: null,
    trades: null,
    holders: [{ address: { hash: `0x${'1'.repeat(40)}` }, value: '5' }],
    transfers: [],
    holdersCount: 1,
  }, expected);
  const browser = normaliseMarket(server, expected);
  assert.equal(browser.state, 'partial');
  assert.equal(browser.pool, '', 'an unread pool stays absent, not invented');
  assert.equal(browser.holdersCount, 1, 'independent chain data survives the second boundary');
  assert.throws(() => normaliseMarket({ ...server, pool: `0x${'9'.repeat(40)}` }, expected), /different token or curve/);
});

test('OHLC observations are chronological and unique by timestamp', async () => {
  const { normaliseMarket } = await import('../assets/market-model.mjs');
  const result = normaliseMarket({
    token: PSTONKS,
    curve: CURVE,
    state: 'complete',
    pool: { address: CURVE },
    ohlcv: [
      ['300', '3', '3', '3', '3', '1'],
      ['300', '9', '9', '9', '3', '2'],
      ['100', '1', '1', '1', '1', '1'],
      ['200', '2', '2', '2', '2', '1'],
    ],
  }, { token: PSTONKS, curve: CURVE });
  assert.deepEqual(result.ohlcv.map((row) => row[0]), ['100', '200', '300']);
  assert.equal(result.ohlcv[2][4], '3', 'the newest provider row for a duplicate timestamp is retained deterministically');
});

test('a missing 24h aggregate cannot prevent independent chain data from painting', () => {
  const app = read('website/assets/app.mjs');
  assert.match(app, /market\.transactions24h\?/, '24h rendering must guard the nullable aggregate');
  assert.doesNotMatch(app, /market\.state==='unavailable'\|\|market\.state==='error'\?'Unavailable':`\$\{market\.transactions24h\.buys\}/);
});
