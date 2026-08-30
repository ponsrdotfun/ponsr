/**
 * Progressive enhancement for the static pages.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A REFACTOR
 * ------------------------------------------
 * This module used to BUILD every page: `APP.replaceChildren(route(feed))`, on
 * top of a shell whose visible text was "Loading verified launch record…".
 * The pages are now real HTML built at deploy time, so this file only refreshes
 * the parts that are bound to live data.
 *
 * THE DIRECTION OF TRAVEL IS ONE-WAY.
 * The build ships every page marked `stale` with the gate `paused`, because a
 * build has observed nothing about right now. This module may UPGRADE that
 * after it has actually read a feed, and it may downgrade it to `partial`,
 * `stale` or `error`. What it must never do is present freshness it did not
 * observe — so every failure path here lands on a worse-or-equal state, never
 * a better one, and a page whose JavaScript never runs keeps telling the truth
 * on its own.
 *
 * Nothing here parses a string into markup: no HTML sinks of any kind. Every
 * value that originates off-chain — token names and symbols above all — reaches
 * the DOM through `textContent` via `render.mjs`. The test that pins this greps
 * the shipped source for those sink names, so even naming them in a comment
 * trips it. That is the test being blunt in the right direction, and the fix is
 * to write the comment differently rather than to loosen the pattern.
 */
import { reduceSourceState, publicGateMessage } from './data-state.mjs';
import { byEventTimeDesc, normaliseLaunch } from './feed-model.mjs';
import { element, setText } from './render.mjs';
// The build renders these same facts. Sharing the formatters is what stops the
// two from drifting -- they already did once, and the page read "1 sells".
import { curveFlowSeries, ethFromWei, eventTime, plural, reserveRows, shortAddress, whole } from './format.mjs';
import { normaliseMarket } from './market-model.mjs';
import { usdFromMicros } from './what-if-model.mjs';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

const STATE_CLASSES = ['state-loading', 'state-complete', 'state-partial', 'state-stale', 'state-error'];

function paintStatus(state, feed) {
  for (const strip of document.querySelectorAll('[data-status-strip]')) {
    strip.classList.remove(...STATE_CLASSES);
    strip.classList.add(`state-${state.kind}`);

    const label = strip.querySelector('[data-status-label]');
    if (label) setText(label, state.label);

    const detail = strip.querySelector('[data-status-detail]');
    if (detail) {
      setText(detail, feed
        ? `Latest verified refresh checked through block ${whole(feed.asOfBlock)}`
        : 'No registry refresh range available');
    }

    // The gate is only ever reported from a value that was actually read. When
    // the feed is missing entirely, the markup's build-time value stands.
    if (!feed) continue;
    const enabled = feed.publicGate?.enabled === true;
    const pill = strip.querySelector('[data-gate-pill]');
    if (pill) setText(pill, `Ponsr launch tooling ${enabled ? 'open' : 'paused'}`);
    const message = strip.querySelector('[data-gate-message]');
    if (message) setText(message, publicGateMessage(enabled));
  }

  const longform = document.querySelector('[data-gate-longform]');
  if (longform && feed) {
    setText(longform, feed.publicGate?.enabled === true
      ? 'Public launching is open. Tag @ponsrdotfun on X with what you want launched, and the record below updates once the block confirms.'
      : 'Public launching is switched off, so tagging Ponsr on X will not create a token right now. The record stays open, and everything already launched remains inspectable.');
  }
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                       */
/* -------------------------------------------------------------------------- */

function fact(list, label, value) {
  const row = element('div', 'fact');
  row.append(element('dt', '', label), element('dd', 'mono', value));
  list.append(row);
}

function trustedLogoUrl(value){if(!value)return null;try{const url=new URL(String(value));if(url.protocol!=='https:'||url.hostname!=='pbs.twimg.com'||url.username||url.password||url.port||!/^\/media\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname))return null;for(const key of url.searchParams.keys())if(!['format','name'].includes(key))return null;return url.toString();}catch{return null;}}
function tokenArtNode(token){const logo=trustedLogoUrl(token.logo),art=element('div',`token-art${logo?' has-image':' unavailable'}`);if(logo){const image=document.createElement('img');image.src=logo;image.alt=`${token.name} token image`;image.loading='lazy';image.decoding='async';art.append(image);return art;}art.setAttribute('role','img');art.setAttribute('aria-label',`Token image unavailable for ${token.symbol}`);const fingerprint=element('span','record-fingerprint');fingerprint.append(element('i'),element('i'),element('i'));art.append(element('span','art-grid'),fingerprint,element('small','','Token image unavailable'));return art;}

function tokenCard(token) {
  const card=element('article','token-card');const art=tokenArtNode(token);
  const body=element('div','launch-card-body');body.append(element('p','eyebrow',`Current V2 · ${token.pairLabel}`));const title=element('div','launch-title');const identity=element('div');identity.append(element('h3','',token.name),element('p','proof-symbol',token.symbol));const inspect=element('a','go','INSPECT →');inspect.href=`/token/${String(token.token).toLowerCase()}`;title.append(identity,inspect);
  const deployer=element('p','deployer','Deployed by ');const deployerLink=element('a','',shortAddress(token.deployer));deployerLink.href=`https://robinhoodchain.blockscout.com/address/${token.deployer}`;deployerLink.target='_blank';deployerLink.rel='noopener noreferrer';deployer.append(deployerLink);
  const copy=element('button','ca-copy');copy.type='button';copy.dataset.copyAddress=token.token;copy.setAttribute('aria-label',`Copy contract address ${token.token}`);copy.append(element('span','mono',shortAddress(token.token)),element('span','','Copy CA'));copy.lastElementChild.dataset.copyLabel='';copy.lastElementChild.setAttribute('role','status');copy.lastElementChild.setAttribute('aria-live','polite');
  const reserve=BigInt(token.reserves?.realQuoteReserveWei||0),threshold=BigInt(token.graduationThreshold||0);const progress=threshold>0n?Number((reserve*100000n)/threshold)/1000:0;const curve=element('div','curve-progress');const curveHead=element('div');curveHead.append(element('span','','Curve progress'),element('strong','',`${progress.toFixed(2)}%`));const bar=element('progress');bar.max=100;bar.value=progress;bar.textContent=`${progress.toFixed(2)}%`;curve.append(curveHead,bar);
  const meta=element('p','launch-meta');meta.append(element('span','',`Block ${whole(token.blockNumber)}`),element('span','',eventTime(token.blockTimestamp)));body.append(title,deployer,copy,curve,meta);card.append(art,body);return card;
}

function latestCanonicalBuyTime(token) {
  return (token.activity?.events||[]).filter((event)=>event.kind==='buy'&&event.blockTimestamp).map((event)=>event.blockTimestamp).sort().at(-1)||token.blockTimestamp||null;
}
function relativeLaunchTime(iso,anchor) {
  const delta=new Date(anchor).getTime()-new Date(iso).getTime();if(!Number.isFinite(delta)||delta<0)return'Time unavailable';const seconds=Math.floor(delta/1000);if(seconds<60)return seconds<5?'now':`${seconds}s ago`;const minutes=Math.floor(seconds/60);if(minutes<60)return`${minutes}m ago`;const hours=Math.floor(minutes/60);if(hours<24)return`${hours}h ago`;return`${Math.floor(hours/24)}d ago`;
}
function sortLaunchpad(launches,sort) {
  const copy=[...launches];if(sort==='oldest')return copy.sort((a,b)=>new Date(a.blockTimestamp||0)-new Date(b.blockTimestamp||0));if(sort==='market-cap')return copy.sort((a,b)=>(Number(b.marketCapUsd)||-1)-(Number(a.marketCapUsd)||-1));if(sort==='recent-buys')return copy.sort((a,b)=>new Date(latestCanonicalBuyTime(b)||0)-new Date(latestCanonicalBuyTime(a)||0));return copy.sort(byEventTimeDesc);
}
function launchpadCardNode(token,anchor) {
  const card=element('article','launchpad-card');const href=`/token/${String(token.token).toLowerCase()}`;const cover=element('a','launchpad-card-link');cover.href=href;cover.setAttribute('aria-label',`Inspect ${token.name}`);
  const media=element('div','launchpad-media');const art=tokenArtNode(token);const badge=element('span','protocol-badge','V2');badge.dataset.protocolBadge='';media.append(art,badge);
  const reserve=BigInt(token.reserves?.realQuoteReserveWei||0),threshold=BigInt(token.graduationThreshold||0);const progress=threshold>0n?Number((reserve*100000n)/threshold)/1000:0;
  const body=element('div','launchpad-card-body');body.append(element('h3','',token.name),element('p','launchpad-symbol',`$${token.symbol}`));const mcap=element('p','launchpad-mcap');mcap.dataset.cardMarketCap='';mcap.append(element('strong','',token.marketCapUsd?`$${Number(token.marketCapUsd).toLocaleString()} MC`:'Market cap unavailable'));body.append(mcap);
  const curve=element('div','launchpad-progress');curve.append(element('span','',`${progress.toFixed(2)}%`));const bar=document.createElement('progress');bar.max=100;bar.value=progress;bar.textContent=`${progress.toFixed(2)}%`;curve.append(bar);body.append(curve,element('p','launchpad-deployer',`by ${shortAddress(token.deployer)}`));
  const bottom=element('div','launchpad-bottom');const copy=element('button');copy.type='button';copy.dataset.copyAddress=token.token;copy.setAttribute('aria-label',`Copy contract address ${token.token}`);copy.append(element('span','',shortAddress(token.token)));const copyLabel=element('i','','Copy');copyLabel.dataset.copyLabel='';copyLabel.setAttribute('role','status');copyLabel.setAttribute('aria-live','polite');copy.append(copyLabel);const time=document.createElement('time');time.dateTime=token.blockTimestamp||'';time.dataset.cardRelativeTime='';time.textContent=relativeLaunchTime(latestCanonicalBuyTime(token),anchor);bottom.append(copy,time);body.append(bottom);card.append(cover,media,body);return card;
}
function paintLaunchpad(feed,state) {
  const grid=document.querySelector('[data-launchpad-grid]');if(!grid||!feed)return;const params=new URLSearchParams(location.search);let sort=params.get('sort')||'recent-buys';if(!['recent-buys','newest','oldest','market-cap'].includes(sort))sort='recent-buys';const query=String(document.querySelector('[data-launch-search]')?.value||'').trim().toLowerCase();const launches=feed.launches.map((raw)=>normaliseLaunch(raw,feed.observedAt)).filter((token)=>!query||[token.name,token.symbol,token.token].some((value)=>String(value).toLowerCase().includes(query)));const sorted=sortLaunchpad(launches,sort);grid.replaceChildren(...sorted.map((token)=>launchpadCardNode(token,feed.observedAt)));setText(document.querySelector('[data-launch-count]'),`${sorted.length} launched`);const sourceCopy=state?.kind==='error'?'Last-known records · live source error':state?.kind==='partial'?'Partial live coverage · preserved records':state?.kind==='stale'?'Last-known snapshot · source not live':'Exact verified records';setText(document.querySelector('[data-result-detail]'),query?`Matching “${query}” · ${sort.replace('-', ' ')} · ${sourceCopy}`:`${sort==='recent-buys'?'Recent canonical buys':sort.replace('-', ' ')} · ${sourceCopy}`);const panel=grid.closest('.launchpad-panel');if(panel)panel.dataset.sourceState=state?.kind||'unknown';const empty=document.querySelector('[data-empty-note]');if(empty)empty.hidden=sorted.length>0;for(const button of document.querySelectorAll('[data-launch-sort]'))button.setAttribute('aria-pressed',String(button.dataset.launchSort===sort));
}
function wireLaunchpad(feed,state) {
  const grid=document.querySelector('[data-launchpad-grid]');if(!grid)return;const search=document.querySelector('[data-launch-search]');const restore=()=>{const params=new URLSearchParams(location.search);if(search)search.value=params.get('q')||'';paintLaunchpad(feed,state);};search?.addEventListener('input',()=>{const params=new URLSearchParams(location.search);const query=search.value.trim();if(query)params.set('q',query);else params.delete('q');history.replaceState(null,'',`${location.pathname}${params.size?`?${params}`:''}`);paintLaunchpad(feed,state);});for(const button of document.querySelectorAll('[data-launch-sort]:not([disabled])'))button.addEventListener('click',()=>{const params=new URLSearchParams(location.search);params.set('sort',button.dataset.launchSort);history.pushState(null,'',`${location.pathname}?${params}`);paintLaunchpad(feed,state);});window.addEventListener('popstate',restore);restore();
}

function paintGrid(feed) {
  const grids = document.querySelectorAll('[data-card-grid]');
  if (!grids.length || !feed) return;

  const scope = document.querySelector('[data-launch-scope]')?.dataset.launchScope || 'official-only';
  const candidates = feed.launches.map((raw) => normaliseLaunch(raw, feed.observedAt));
  const allLaunches = (scope === 'all-verified-v2' ? candidates : candidates.filter((launch) => launch.officialPonsr === true)).sort(byEventTimeDesc);
  const search = document.querySelector('[data-launch-search]');
  const query = String(search?.value || '').trim().toLowerCase();
  const launches = query
    ? allLaunches.filter((token) => [token.name, token.symbol, token.token]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    : allLaunches;

  for (const grid of grids) {
    const isHome = grid.hasAttribute('data-home-launch-grid');
    const visible = isHome ? launches.slice(0, 6) : launches;
    grid.classList.toggle('is-single', visible.length === 1);
    grid.replaceChildren(...visible.map(tokenCard));
  }

  const count = document.querySelector('[data-count]');
  if (count) setText(count, `${launches.length} ${scope === 'all-verified-v2' ? 'verified ' : 'official '}launch${launches.length === 1 ? '' : 'es'}`);
  const detail = document.querySelector('[data-result-detail]');
  if (detail) setText(detail, query ? `Matching “${query}” · newest first` : 'Newest first · exact current-V2 records');

  // Empty and broken are different states, and a filter with no matches is a
  // third state. None of them may be presented as proof that nothing launched.
  for (const note of document.querySelectorAll('[data-empty-note]')) {
    note.hidden = launches.length > 0;
    if (launches.length > 0) continue;
    const broken = state.kind === 'error' || state.kind === 'partial';
    note.replaceChildren(
      element('strong', '', broken ? 'The record could not be read' : query ? 'No matching launches' : 'Nothing to show yet'),
      document.createTextNode(broken
        ? 'The source did not answer completely, so this is not a statement that nothing has launched.'
        : query ? 'Try a token name, symbol, or exact 0x address.' : 'No current V2 launch has been recorded by Ponsr.'),
    );
  }
}

function wireCopyButtons() {
  document.addEventListener('click',async(event)=>{const button=event.target.closest?.('[data-copy-address]');if(!button)return;const address=button.dataset.copyAddress;const label=button.querySelector('[data-copy-label]');const idleLabel=label?.textContent||'Copy CA';if(!/^0x[a-fA-F0-9]{40}$/.test(address||''))return;try{await navigator.clipboard.writeText(address);setText(label,'Copied');button.classList.add('copied');window.setTimeout(()=>{setText(label,idleLabel);button.classList.remove('copied');},1600);}catch{setText(label,'Copy failed');}});
}

function wireLaunchSearch(feed, state) {
  const search = document.querySelector('[data-launch-search]');
  if (!search) return;
  search.addEventListener('input', () => paintGrid(feed, state));
}

/* -------------------------------------------------------------------------- */
/* Token page                                                                  */
/* -------------------------------------------------------------------------- */

function paintCurveActivity(token) {
  const host=document.querySelector('[data-curve-flow-chart]'),series=curveFlowSeries(token.activity);if(!host||!series.length)return;
  const width=640,height=220,padX=34,padY=26,numeric=series.map((event)=>Number(BigInt(event.netQuoteWei))/1e18),min=Math.min(0,...numeric),max=Math.max(0,...numeric),span=max-min||1;
  const points=series.map((event,index)=>({event,x:series.length===1?width/2:padX+(index*(width-padX*2))/(series.length-1),y:height-padY-((numeric[index]-min)/span)*(height-padY*2)}));
  const buyWei=series.filter((event)=>event.kind==='buy').reduce((sum,event)=>sum+BigInt(event.quoteWei),0n),sellWei=series.filter((event)=>event.kind==='sell').reduce((sum,event)=>sum+BigInt(event.quoteWei),0n),netWei=BigInt(series.at(-1).netQuoteWei),direction=netWei>=0n?'inflow':'outflow',absNet=netWei<0n?-netWei:netWei;
  const head=element('div','curve-flow-head'),heading=element('div');heading.append(element('p','eyebrow','Cumulative quote accounting · authoritative block time'),element('h2','','Net ETH flow'),element('p','flow-intro','See how much native ETH entered through buys, exited through sells, and remained as net transaction flow.'));
  const summary=element('div',`flow-summary ${direction}`);summary.append(element('span','flow-not-price','Not token price · liquidity · PnL'),element('span','flow-summary-label',`Net ${direction}`),element('p','mono',ethFromWei(absNet,18)));head.append(heading,summary);
  const source=element('p',`flow-source ${token.activity?.sourceState==='complete'?'complete':'stale'}`,`${token.activity?.sourceState==='complete'?'Activity indexed':'Last-known activity'} through block ${whole(token.activity?.observedThroughBlock)}${token.activity?.sourceState==='partial'?' · source partial':''}`);
  const rail=element('div','flow-metric-rail');for(const [key,label,value,note,cls=''] of [['flowBuyInflow','Buy inflow',`+${ethFromWei(buyWei,18)}`,'Σ verified CurveBuy quote in'],['flowSellOutflow','Sell outflow',ethFromWei(sellWei,18),'Unsigned magnitude · subtracted from buys'],['flowNetInflow',`Net ${direction}`,`${direction==='inflow'?'+':'−'}${ethFromWei(absNet,18)}`,'Buy inflow − sell outflow',`net ${direction}`]]){const card=element('article',cls);card.dataset[key]='';card.append(element('span','',label),element('strong','',value),element('small','',note));rail.append(card);}
  const note=element('div','flow-ledger-note'),noteIcon=element('span','','◇');noteIcon.setAttribute('aria-hidden','true');const noteCopy=element('p');noteCopy.append(element('strong','','Transaction-flow ledger'),document.createTextNode('Direction and cumulative ETH movement through exact curve events—not valuation or available reserve.'));note.append(noteIcon,noteCopy);
  const ns='http://www.w3.org/2000/svg',plot=element('div','flow-plot'),plotHead=element('div','flow-plot-head');plotHead.append(element('span','','Running net flow'),element('span','','Older events → newer events'));const maxWei=series.reduce((best,event)=>BigInt(event.netQuoteWei)>best?BigInt(event.netQuoteWei):best,0n);plot.append(plotHead,element('span','flow-scale flow-scale-max',ethFromWei(maxWei,18)),element('span','flow-scale flow-scale-zero','0 ETH'));
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('class','flow-chart');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');const title=document.createElementNS(ns,'title');title.textContent='Running net ETH flow through the bonding curve';svg.append(title);
  for(const ratio of [.25,.5,.75]){const line=document.createElementNS(ns,'line'),y=padY+(height-padY*2)*ratio;for(const [key,value] of Object.entries({class:'flow-grid-line',x1:padX,x2:width-padX,y1:y,y2:y}))line.setAttribute(key,String(value));svg.append(line);}const zero=document.createElementNS(ns,'line'),zeroY=height-padY-((0-min)/span)*(height-padY*2);for(const [key,value] of Object.entries({class:'flow-zero',x1:padX,x2:width-padX,y1:zeroY,y2:zeroY}))zero.setAttribute(key,String(value));svg.append(zero);
  const pathData=points.map((point,index)=>index===0?`M ${point.x.toFixed(2)} ${zeroY.toFixed(2)} V ${point.y.toFixed(2)}`:`H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`).join(' ');for(const cls of ['flow-line-glow','flow-line']){const path=document.createElementNS(ns,'path');path.setAttribute('class',cls);path.setAttribute('d',pathData);svg.append(path);}for(const {event,x,y} of points){const group=document.createElementNS(ns,'g');group.setAttribute('class',`flow-marker ${event.kind}`);const circle=document.createElementNS(ns,'circle');circle.setAttribute('cx',x.toFixed(2));circle.setAttribute('cy',y.toFixed(2));circle.setAttribute('r','9');const text=document.createElementNS(ns,'text');text.setAttribute('x',x.toFixed(2));text.setAttribute('y',(y-17).toFixed(2));text.setAttribute('text-anchor','middle');text.textContent=event.kind==='buy'?'BUY':'SELL';group.append(circle,text);svg.append(group);}const legend=element('div','flow-legend');legend.append(element('span','buy','● BUY adds ETH'),element('span','sell','● SELL removes ETH'));plot.append(svg,legend);
  const listHead=element('div','flow-list-head'),listTitle=element('div');listTitle.append(element('p','eyebrow','Canonical event ledger'),element('h3','','Verified curve events'));listHead.append(listTitle,element('span','eyebrow','Newest first'));const list=element('ol','flow-events');for(const event of series.slice().reverse()){const item=element('li',`flow-event ${event.kind}`),detail=element('span'),link=element('a','text-link','tx ↗');detail.append(element('strong','',`${event.kind==='buy'?'Quote in +':'Quote out −'}${ethFromWei(event.quoteWei,18)}`),element('small','',`Cumulative ${ethFromWei(event.netQuoteWei,18)} · ${eventTime(event.blockTimestamp)} · block ${whole(event.blockNumber)}`));link.href=`https://robinhoodchain.blockscout.com/tx/${event.transactionHash}`;link.target='_blank';link.rel='noopener noreferrer';item.append(element('span','flow-kind',event.kind==='buy'?'BUY':'SELL'),detail,link);list.append(item);}host.replaceChildren(head,source,rail,note,plot,listHead,list);
}

function paintCanonicalTrades(token) {
  const list=document.querySelector('[data-market-trades]'),count=document.querySelector('[data-trade-count]'),series=curveFlowSeries(token.activity);
  if(!list||!count)return;
  if(!series.length){setText(count,'Unavailable');list.replaceChildren(element('li','market-empty','Canonical CurveBuy / CurveSell activity is unavailable for this observation range.'));return;}
  setText(count,String(series.length));
  const items=series.slice().reverse().map((event)=>{const item=element('li',`market-trade ${event.kind}`),kind=element('span','market-kind',event.kind.toUpperCase()),data=element('span',''),link=element('a','text-link','tx ↗');data.append(element('strong','',`${event.kind==='buy'?'Quote in +':'Quote out −'}${ethFromWei(event.quoteWei,18)}`),element('small','',`${eventTime(event.blockTimestamp)} · block ${whole(event.blockNumber)}`));link.href=`https://robinhoodchain.blockscout.com/tx/${event.transactionHash}`;link.target='_blank';link.rel='noopener noreferrer';item.append(kind,data,link);return item;});
  list.replaceChildren(...items);
}

function paintTokenPage(feed) {
  const host = document.querySelector('[data-token-address]');
  if (!host || !feed) return;
  const address = String(host.dataset.tokenAddress || '').toLowerCase();
  const token = feed.launches.find((item) => String(item.token).toLowerCase() === address);
  if (!token) return;

  const reserves=document.querySelector('[data-reserves]'),rows=reserveRows(token);
  if(reserves&&rows){const values=Object.fromEntries(rows),grid=element('div','reserve-metric-grid');for(const [label,note] of [['Real quote reserve','Observed native ETH'],['Graduation threshold','Protocol threshold']]){const card=element('article');card.append(element('span','',label),element('strong','',values[label]),element('small','',note));grid.append(card);}const state=element('div','curve-state-row');state.append(element('span','','Curve status'),element('strong','',values['Curve status']),element('small','',`Observed at ${values['Observed at']}`));reserves.replaceChildren(grid,state,element('p','observation-note','A single reading, not a live figure. It was true at the observation above, and it is not extrapolated anywhere on this page.'));}

  const activity=document.querySelector('[data-activity]');
  if(activity&&Number.isFinite(token.activity?.curveBuys)&&Number.isFinite(token.activity?.curveSells)){const grid=element('div','observation-grid');for(const [label,value,note] of [['Verified activity',`${plural(token.activity.curveBuys,'buy','buys')} · ${plural(token.activity.curveSells,'sell','sells')}`,'CurveBuy / CurveSell'],['Indexed coverage',`Through block ${whole(token.activity.observedThroughBlock)}`,token.activity?.sourceState==='complete'?'Complete observation':'Last-known observation']]){const card=element('article');card.append(element('span','',label),element('strong','',value),element('small','',note));grid.append(card);}activity.replaceChildren(grid);}
  paintCurveActivity(token);
  paintCanonicalTrades(token);
}

function dynamicWorkstation(token){
  const wrap=element('div','dynamic-workstation');
  const market=element('section','panel market-terminal');market.dataset.marketTerminal='';market.dataset.token=token.token;market.dataset.curve=token.curve;
  const heading=element('div','flow-list-head');heading.append(element('h2','','Market data'),element('span','eyebrow','Loading…'));heading.lastChild.dataset.marketState='';
  const stats=element('div','market-stat-grid');for(const [label,key] of [['Price USD','marketPrice'],['24h volume','marketVolume'],['24h flow','marketTransactions'],['FDV','marketFdv'],['Holders','holderCount']]){const card=element('article');card.append(element('span','',label),element('strong','','Unavailable'));card.lastChild.dataset[key]='';stats.append(card);}
  const tabs=element('div','activity-terminal'),holders=element('ol','');holders.dataset.tokenHolders='';const transfers=element('ol','');transfers.dataset.tokenTransfers='';const counts=element('p','observation-note');counts.append(element('span','','Holders '),element('strong','','Unavailable'),element('span','',' · Transfers '),element('strong','','Unavailable'));counts.children[1].dataset.holderTabCount='';counts.children[3].dataset.transferCount='';tabs.append(counts,holders,transfers);market.append(heading,stats,tabs);
  const iframe=document.createElement('iframe');iframe.className='gecko-chart-frame';iframe.src=`https://www.geckoterminal.com/robinhood/tokens/${token.token}?embed=1&info=0&swaps=0`;iframe.loading='lazy';iframe.referrerPolicy='strict-origin-when-cross-origin';iframe.title=`${token.symbol||'Token'} GeckoTerminal chart`;market.append(iframe);
  const simulator=element('section','panel what-if-lab');simulator.dataset.whatIfSimulator='';simulator.dataset.token=token.token;const input=document.createElement('input');input.type='text';input.placeholder='0x wallet address';input.dataset.walletInput='';const run=element('button','btn btn-primary','Run analysis');run.type='button';run.dataset.runSimulator='';const status=element('div','simulator-state');status.dataset.simulatorState='';const results=element('div','simulator-results');results.dataset.simulatorResults='';results.hidden=true;for(const key of ['neverSold','actualNow','whatIfDelta','whatIfTrades']){const out=element('strong','','Unavailable');out.dataset[key]='';results.append(out);}const audit=element('div','simulator-audit');audit.dataset.simulatorAudit='';audit.hidden=true;for(const key of ['auditBought','auditBalance','auditRealized','auditTokenPrice','auditQuotePrice','auditTime']){const out=element('span','','Unavailable');out.dataset[key]='';audit.append(out);}const tradeList=element('ol','');tradeList.dataset.auditTrades='';audit.append(tradeList);simulator.append(element('h2','','Read-only What-if'),input,run,status,results,audit);wrap.append(market,simulator);return wrap;
}

function paintDynamicTokenPage(feed, state) {
  const host = document.querySelector('[data-dynamic-token-page]');
  if (!host) return;
  const match = window.location.pathname.match(/^\/token\/(0x[a-fA-F0-9]{40})\/?$/);
  const title = host.querySelector('[data-dynamic-token-title]');
  const message = host.querySelector('[data-dynamic-token-message]');
  const content = host.querySelector('[data-dynamic-token-content]');

  if (!match) {
    if (title) setText(title, 'Invalid token address');
    if (message) setText(message, 'Use an exact 0x contract address from the Ponsr launch collection.');
    return;
  }
  if (!feed) {
    if (title) setText(title, 'The record is unavailable');
    if (message) setText(message, 'The launch source could not be read, so this address cannot be classified yet.');
    return;
  }

  const address = match[1].toLowerCase();
  const token = feed.launches.find((item) => String(item.token).toLowerCase() === address);
  if (!token) {
    if (title) setText(title, 'Not on the record');
    if (message) setText(message, state.kind === 'partial' || state.kind === 'error'
      ? 'The source is incomplete, so this is not proof that Ponsr never launched this address.'
      : 'This exact address is not in the verified current-V2 Ponsr collection.');
    return;
  }

  document.title = `${token.name} (${token.symbol}) — Ponsr`;
  if (title) setText(title, token.name);
  if (message) setText(message, `${token.symbol} · ${token.pairLabel} · block ${whole(token.blockNumber)}`);
  if (content) {
    const panel = element('article', 'panel dynamic-token-panel');
    const identity = element('div', 'proof-id');
    identity.append(
      tokenArtNode(token),
      element('p', 'eyebrow', `Current V2 · ${token.pairLabel}`),
      element('h2', 'metal', token.name),
      element('p', 'proof-symbol', token.symbol),
      element('p','token-description',token.description||'Token description unavailable.'),
    );
    const provenance = element('dl', 'facts');
    fact(provenance, 'Token', shortAddress(token.token));
    fact(provenance, 'Curve', token.curve ? shortAddress(token.curve) : 'Not published');
    fact(provenance, 'Block', whole(token.blockNumber));
    fact(provenance, 'Launched', eventTime(token.blockTimestamp));
    panel.append(identity, provenance);
    content.replaceChildren(panel,dynamicWorkstation(token));
    wireSimulator();
    loadMarket();
  }
}

/* -------------------------------------------------------------------------- */
/* External market terminal + read-only What-if lab                           */
/* -------------------------------------------------------------------------- */

const usd = (value) => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Number(value) < 0.01 ? 8 : 2 }).format(Number(value));

function paintMarket(raw, expected) {
  const host=document.querySelector('[data-market-terminal]');if(!host)return;
  const market=normaliseMarket(raw,expected);host.dataset.marketState=market.state;
  const sourceState=market.state==='complete'?'fetch complete':market.state;
  setText(host.querySelector('[data-market-state]'),`${market.source} · ${sourceState}${market.observedAt?` · ${eventTime(market.observedAt)}`:''}`);
  setText(host.querySelector('[data-market-price]'),usd(market.priceUsd));
  setText(host.querySelector('[data-market-volume]'),usd(market.volume24hUsd));
  setText(host.querySelector('[data-market-fdv]'),market.fdvUsd?usd(market.fdvUsd):'Unavailable');
  // A range that was not read reads Unavailable everywhere, including the tab
  // counters. They used to come from `array.length`, so a rejected provider
  // call rendered as 0 beside a stat that said Unavailable on the same page.
  const avail=market.availability||{};
  const rangeCount=(kind,list)=>avail[kind]==='complete'?String(list.length):'Unavailable';
  setText(host.querySelector('[data-holder-count]'),market.holdersCount===null?'Unavailable':String(market.holdersCount));
  setText(host.querySelector('[data-holder-tab-count]'),market.holdersCount===null?rangeCount('holders',market.holders):String(market.holdersCount));
  setText(host.querySelector('[data-transfer-count]'),rangeCount('transfers',market.transfers));
  setText(host.querySelector('[data-market-transactions]'),market.transactions24h?`${market.transactions24h.buys} buy${market.transactions24h.buys===1?'':'s'} / ${market.transactions24h.sells} sell${market.transactions24h.sells===1?'':'s'}`:'Unavailable');

  const holders=host.querySelector('[data-token-holders]');if(holders){const total=(market.holders||[]).reduce((sum,holder)=>sum+BigInt(holder.amountRaw),0n);const items=(market.holders||[]).map((holder,index)=>{const item=element('li','dense-activity-row');item.append(element('span','rank',String(index+1).padStart(2,'0')),element('a','mono',shortAddress(holder.address)),element('strong','',`${rawUnits(holder.amountRaw)} tokens`),element('small','',total>0n?`${Number((BigInt(holder.amountRaw)*10000n)/total)/100}% of observed holder balances`:'Share unavailable'));const link=item.querySelector('a');link.href=`https://robinhoodchain.blockscout.com/address/${holder.address}`;link.target='_blank';link.rel='noopener noreferrer';return item;});holders.replaceChildren(...(items.length?items:[element('li','market-empty','No holders were derived from the observed Transfer-log range.')]));}
  const transfers=host.querySelector('[data-token-transfers]');if(transfers){const items=(market.transfers||[]).slice(0,12).map((transfer)=>{const item=element('li','dense-activity-row transfer');item.append(element('span','market-kind','TRANSFER'),element('span','mono',`${shortAddress(transfer.from)} → ${shortAddress(transfer.to)}`),element('strong','',`${rawUnits(transfer.amountRaw,transfer.decimals)} tokens`),element('small','',`${eventTime(transfer.blockTimestamp)} · block ${whole(transfer.blockNumber)}`));const link=element('a','text-link','tx ↗');link.href=`https://robinhoodchain.blockscout.com/tx/${transfer.transactionHash}`;link.target='_blank';link.rel='noopener noreferrer';item.append(link);return item;});transfers.replaceChildren(...(items.length?items:[element('li','market-empty','No transfers were returned from the observed Transfer-log range.')]));}
}

async function loadMarket() {
  const host=document.querySelector('[data-market-terminal]');if(!host)return;
  const token=host.dataset.token,curve=host.dataset.curve;
  try{const response=await fetch(`/.netlify/functions/market-data?token=${encodeURIComponent(token)}`,{headers:{accept:'application/json'}});const payload=await response.json();paintMarket(payload,{token,curve});}
  catch{paintMarket({state:'error',problem:'Market source unavailable.'},{token,curve});}
}

function simulatorState(host,title,detail,state='loading') { host.dataset.simulatorState=state;const box=host.querySelector('[data-simulator-state]');if(box){box.id='simulator-status';box.setAttribute('role',state==='error'?'alert':'status');box.setAttribute('aria-live',state==='error'?'assertive':'polite');box.replaceChildren(element('strong','',title),element('p','',detail));}const input=host.querySelector('[data-wallet-input]');if(input){input.setAttribute('aria-describedby','simulator-status');input.setAttribute('aria-invalid',String(state==='error'));} }
const rawUnits=(value,decimals=18,precision=6)=>{const raw=BigInt(value||0),scale=10n**BigInt(decimals),whole=raw/scale,fraction=(raw%scale).toString().padStart(decimals,'0').slice(0,precision).replace(/0+$/,'');return `${whole.toLocaleString('en-US')}${fraction?`.${fraction}`:''}`;};

async function runSimulator(host) {
  const input=host.querySelector('[data-wallet-input]');const wallet=String(input?.value||'').trim();const token=host.dataset.token;
  if(!/^0x[a-fA-F0-9]{40}$/.test(wallet)){simulatorState(host,'Invalid wallet','Enter an exact 0x wallet address.','error');return;}
  if(input)input.setAttribute('aria-invalid','false');simulatorState(host,'Reconstructing history','Reconciling canonical curve events, exact chain Transfer logs, RPC transaction senders/current balance, and GeckoTerminal current price.','loading');
  try{const response=await fetch(`/.netlify/functions/what-if?token=${encodeURIComponent(token)}&wallet=${encodeURIComponent(wallet)}`,{headers:{accept:'application/json'}});const result=await response.json();const zeroAuthority=result.executionAuthority==='NONE_PREVIEW_ONLY'&&result.canSign===false&&result.canSend===false&&result.canSwap===false&&result.canClaim===false&&result.isExecutableQuote===false;if(!response.ok||!zeroAuthority||!['complete','partial'].includes(result.state)){simulatorState(host,'Analysis unavailable',result.problem||result.reason||'The sources could not be reconciled.','error');return;}const results=host.querySelector('[data-simulator-results]');setText(host.querySelector('[data-never-sold]'),usdFromMicros(result.neverSoldUsdMicros));setText(host.querySelector('[data-actual-now]'),usdFromMicros(result.actualUsdMicros));setText(host.querySelector('[data-what-if-delta]'),usdFromMicros(result.deltaUsdMicros));setText(host.querySelector('[data-what-if-trades]'),String(result.tradeCount));if(results)results.hidden=false;const audit=host.querySelector('[data-simulator-audit]');setText(host.querySelector('[data-audit-bought]'),`${rawUnits(result.totalBoughtRaw)} tokens`);setText(host.querySelector('[data-audit-balance]'),`${rawUnits(result.currentBalanceRaw)} tokens`);setText(host.querySelector('[data-audit-realized]'),`${rawUnits(result.realizedQuoteRaw)} ETH`);setText(host.querySelector('[data-audit-token-price]'),usd(result.tokenPriceUsd));setText(host.querySelector('[data-audit-quote-price]'),usd(result.quotePriceUsd));setText(host.querySelector('[data-audit-time]'),eventTime(result.observedAt));const auditTrades=host.querySelector('[data-audit-trades]');if(auditTrades){auditTrades.replaceChildren(...(result.trades||[]).map((trade)=>{const item=element('li',`flow-event ${trade.kind}`);const kind=element('span','flow-kind',trade.kind.toUpperCase());const detail=element('span','');detail.append(element('strong','',`${rawUnits(trade.walletTokenRaw)} tokens · ${rawUnits(trade.quoteRaw)} ETH`),element('small','',`${eventTime(trade.blockTimestamp)} · block ${whole(trade.blockNumber)}`));const link=element('a','text-link','tx ↗');link.href=`https://robinhoodchain.blockscout.com/tx/${trade.txHash}`;link.target='_blank';link.rel='noopener noreferrer';item.append(kind,detail,link);return item;}));}if(audit)audit.hidden=false;const noSells=BigInt(result.totalSoldRaw||0)===0n;simulatorState(host,result.state==='complete'?'Reconciled analysis':'Partial analysis',result.state==='complete'?(noSells?`Observed ${result.tradeCount} wallet buy${result.tradeCount===1?'':'s'} and no sells; actual and never-sold scenarios are expected to match.`:`Observed ${result.tradeCount} wallet trade${result.tradeCount===1?'':'s'} across all returned sources.`):'One or more canonical event, transfer, transaction, balance, or price sources is incomplete. Treat these figures as incomplete.',result.state);}
  catch{simulatorState(host,'Analysis unavailable','The read-only sources did not answer. No estimate is shown.','error');}
}

function wireActivityTabs() {
  const host=document.querySelector('.activity-terminal');if(!host)return;const tabs=[...host.querySelectorAll('[data-activity-tab]')];
  const select=(name)=>{for(const tab of tabs){const selected=tab.dataset.activityTab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}for(const pane of host.querySelectorAll('[data-activity-pane]'))pane.hidden=pane.dataset.activityPane!==name;};
  tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>select(tab.dataset.activityTab));tab.addEventListener('keydown',(event)=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];next.focus();select(next.dataset.activityTab);});});
}

function wireSimulator() {
  const host=document.querySelector('[data-what-if-simulator]');if(!host)return;
  host.querySelector('[data-run-simulator]')?.addEventListener('click',()=>runSimulator(host));
  host.querySelector('[data-connect-wallet]')?.addEventListener('click',async()=>{if(!window.ethereum?.request){simulatorState(host,'MetaMask unavailable','Install or open a compatible injected wallet, or paste an address instead.','error');return;}try{const accounts=await window.ethereum.request({method:'eth_requestAccounts'});const selected=Array.isArray(accounts)?accounts[0]:null;if(!/^0x[a-fA-F0-9]{40}$/.test(selected||''))throw new Error('no address');const input=host.querySelector('[data-wallet-input]');if(input)input.value=selected;simulatorState(host,'Wallet selected','Address selected read-only. Press Run analysis to query public history.','complete');}catch{simulatorState(host,'Wallet not selected','No address was returned. Nothing was signed or sent.','error');}});
}

/* -------------------------------------------------------------------------- */
/* Motion                                                                      */
/* -------------------------------------------------------------------------- */

const motionAnimations=new WeakMap();
function motionTo(node,keyframes,options={}){if(!node)return;motionAnimations.get(node)?.cancel();const animation=node.animate([{},keyframes],{duration:options.duration??90,easing:options.easing??'cubic-bezier(.2,.8,.2,1)',fill:'forwards'});animation.startTime=document.timeline.currentTime;motionAnimations.set(node,animation);}
function createMotionChannel(node,duration=420){
  if(!node)return()=>{};
  const animation=node.animate([{},{}],{duration,easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'});animation.pause();animation.currentTime=duration;
  return(keyframe)=>{const computed=getComputedStyle(node),from={};for(const property of Object.keys(keyframe))from[property]=computed.getPropertyValue(property);animation.effect.setKeyframes([from,keyframe]);animation.currentTime=0;animation.play();animation.startTime=document.timeline.currentTime;};
}

function wirePremiumTilt() {
  if(reduceMotion||!window.matchMedia('(pointer: fine)').matches)return;
  for(const node of document.querySelectorAll('[data-tilt]')){let frame=0;const reset=()=>motionTo(node,{transform:'none'},{duration:320});node.addEventListener('pointermove',(event)=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const rect=node.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width-.5;const y=(event.clientY-rect.top)/rect.height-.5;motionTo(node,{transform:`perspective(700px) rotateX(${(-y*8).toFixed(2)}deg) rotateY(${(x*10).toFixed(2)}deg) translate3d(${(x*4).toFixed(2)}px,${(y*4).toFixed(2)}px,18px)`});});});node.addEventListener('pointerleave',reset);}
}

function wireLivingMascot() {
  if(!window.matchMedia('(pointer: fine)').matches)return;
  const avatar=document.querySelector('[data-bot-avatar]'),glow=document.querySelector('[data-cursor-glow]'),eyes=[...document.querySelectorAll('[data-bot-eye]')];
  if(!avatar||!eyes.length)return;
  const maxX=avatar.offsetWidth*.040,maxY=avatar.offsetWidth*.032,glowHalf=glow?glow.getBoundingClientRect().width/2:0,moveGlow=createMotionChannel(glow,120),eyeState=eyes.map((eye)=>{const rect=eye.getBoundingClientRect();return{cx:rect.left+rect.width/2,cy:rect.top+rect.height/2,move:createMotionChannel(eye,55)};});
  const look=(event)=>{
    if(glow&&!reduceMotion)moveGlow({opacity:'1',transform:`translate(${(event.clientX-glowHalf).toFixed(1)}px,${(event.clientY-glowHalf).toFixed(1)}px)`});
    // Off-screen: do nothing. Production skips here too, and without it the
    // gaze keeps measuring and animating an element nobody can see.
    const botRect=avatar.getBoundingClientRect();
    if(botRect.bottom<-120||botRect.top>window.innerHeight+120)return;
    for(const state of eyeState){const vx=event.clientX-state.cx,vy=event.clientY-state.cy,distance=Math.hypot(vx,vy);if(distance<.5)continue;const pull=Math.min(1,distance/380),ex=vx/distance*maxX*pull,ey=vy/distance*maxY*pull;state.move({transform:`translate(calc(-50% + ${ex.toFixed(2)}px),calc(-50% + ${ey.toFixed(2)}px))`});}
  };
  const reset=()=>{if(glow)moveGlow({opacity:'0'});for(const state of eyeState)state.move({transform:'translate(-50%,-50%)'});};
  window.addEventListener('pointermove',look,{passive:true});document.addEventListener('pointerleave',reset);window.addEventListener('blur',reset);
}

function revealOnScroll() {
  const targets = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    for (const node of targets) node.classList.add('shown');
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('shown');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px 12% 0px', threshold: 0.04 });
  for (const node of targets) {
    const rect=node.getBoundingClientRect();
    if(rect.top<innerHeight&&rect.bottom>0)node.classList.add('shown','reveal-immediate');
    else observer.observe(node);
  }
  // Content must not remain invisible when a browser restores scroll position,
  // suppresses intersection callbacks, or captures a full page without scrolling.
  window.setTimeout(() => {
    for (const node of targets) node.classList.add('shown');
    observer.disconnect();
  }, 1200);
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

const accountCookie=(name)=>document.cookie.split(';').map((v)=>v.trim()).find((v)=>v.startsWith(`${name}=`))?.slice(name.length+1)||'';
async function readAccountJson(path,options={}){const response=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json',...(options.headers||{})},...options});const body=await response.json().catch(()=>({state:'error'}));return{ok:response.ok,body};}
function paintAccountSession(session){const root=document.querySelector('.account-shell');if(!root)return;const signIn=root.querySelector('[data-account-signin]'),logout=root.querySelector('[data-account-logout]'),label=root.querySelector('[data-account-session-label]'),title=root.querySelector('[data-account-session-title]'),detail=root.querySelector('[data-account-session-detail]'),mode=root.querySelector('[data-account-mode]');if(session?.state==='authenticated'){root.dataset.authState='authenticated';root.dataset.identityState='verified';root.dataset.privateDataState='authenticated';root.dataset.executionAuthority='NONE_PREVIEW_ONLY';setText(label,`Verified X identity · @${session.identity.handle}`);setText(title,'Existing wallet continuity verified');setText(detail,`${session.wallet.address} · read-only account access · signing, send, swap, and claims remain disabled.`);setText(mode,'Phase B · Authenticated read-only');setText(root.querySelector('.account-sidebar-state strong'),'Authenticated');const badge=root.querySelector('.state-badge');if(badge&&!badge.classList.contains('status-readonly'))setText(badge,'Authenticated · read-only');if(signIn)signIn.hidden=true;if(logout)logout.hidden=false;const wallet=root.querySelector('.wallet-address-shell strong');if(wallet)setText(wallet,session.wallet.address);for(const stat of root.querySelectorAll('.account-stat')){const label=stat.querySelector('p')?.textContent;if(label==='Embedded wallet')setText(stat.querySelector('strong'),shortAddress(session.wallet.address));}for(const item of root.querySelectorAll('.security-list article')){const label=item.querySelector('strong')?.textContent;if(label==='Identity binding')setText(item.querySelector('span'),'Verified');if(label==='Wallet continuity')setText(item.querySelector('span'),'Verified');if(label==='Session controls')setText(item.querySelector('span'),'Active');}return;}root.dataset.authState='signed-out';root.dataset.identityState='unavailable';root.dataset.privateDataState='locked';if(logout)logout.hidden=true;}
async function wireAccount(){const root=document.querySelector('.account-shell');if(!root)return;let ready={state:'unavailable'};try{ready=(await readAccountJson('/api/ready')).body;}catch{}let session={state:'unauthenticated'};try{session=(await readAccountJson('/api/account/session')).body;}catch{}paintAccountSession(session);const signIn=root.querySelector('[data-account-signin]'),logout=root.querySelector('[data-account-logout]');if(session.state==='authenticated'){const host=root.querySelector('[data-account-launches]');if(host)try{const result=await readAccountJson('/api/account/launches');if(!result.ok||!Array.isArray(result.body.launches)){setText(host,'Launch records are temporarily unavailable.');}else{const nodes=result.body.launches.map((launch)=>{const article=element('article','account-launch-record');article.append(element('strong','',`${launch.tokenName} · ${launch.tokenSymbol}`),element('p','',`${launch.status} · ${eventTime(launch.createdAt)}`));if(/^0x[a-fA-F0-9]{40}$/.test(String(launch.tokenAddress||''))){const link=element('a','text-link','Open token →');link.href=`/token/${String(launch.tokenAddress).toLowerCase()}`;article.append(link);}return article;});host.replaceChildren(...(nodes.length?nodes:[element('p','','No launch records are bound to this verified identity.') ]));}}catch{setText(host,'Launch records are temporarily unavailable.');}}if(session.state!=='authenticated'&&ready.state==='ready'&&ready.siteOrigin===location.origin&&signIn){signIn.disabled=false;signIn.removeAttribute('aria-disabled');signIn.classList.remove('btn-disabled');signIn.textContent='Sign in with X';signIn.addEventListener('click',async()=>{signIn.disabled=true;const result=await readAccountJson('/api/auth/x/start',{method:'POST'});if(result.ok&&result.body.authorizationUrl)location.assign(result.body.authorizationUrl);else{signIn.disabled=false;setText(root.querySelector('[data-account-session-detail]'),'Sign-in is temporarily unavailable. No wallet or private account state was changed.');}});}logout?.addEventListener('click',async()=>{const csrf=decodeURIComponent(accountCookie('__Host-ponsr_csrf'));const result=await readAccountJson('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});if(result.ok)location.assign('/account/');else setText(root.querySelector('[data-account-session-detail]'),'Sign-out failed. Your authenticated session remains active; retry before leaving this device.');});}

async function readFeed() {
  // The function is authoritative; the committed snapshot is the fallback. A
  // fallback read is still a real observation, so it may set state — but the
  // snapshot has no live coverage, which `reduceSourceState` sees through its
  // `generatedAt` age and reports as stale rather than complete.
  try {
    const response = await fetch('/.netlify/functions/launch-feed', { headers: { accept: 'application/json' } });
    if (response.ok) return { feed: await response.json(), error: null };
  } catch { /* fall through to the static snapshot */ }
  try {
    const response = await fetch('/data/launches.json', { headers: { accept: 'application/json' } });
    if (response.ok) return { feed: await response.json(), error: null };
  } catch { /* nothing readable */ }
  return { feed: null, error: new Error('No launch record could be read') };
}

function paintAccountSimulator(feed,state) {
  const account=document.querySelector('.account-shell');if(!account)return;
  account.dataset.publicSourceState=state.kind;
  account.dataset.publicThroughBlock=Number.isFinite(Number(feed?.asOfBlock))?String(feed.asOfBlock):'';
  account.dataset.publicObservedAt=typeof feed?.observedAt==='string'?feed.observedAt:'';
  const directory=account.querySelector('[data-account-simulator-launches]');
  if(!directory||!Array.isArray(feed?.launches))return;
  const items=feed.launches.filter((token)=>/^0x[a-fA-F0-9]{40}$/.test(String(token.token||''))).map((token)=>{
    const link=element('a','token-card');link.href=`/token/${String(token.token).toLowerCase()}#what-if`;
    const top=element('div','top'),copy=element('div','');copy.append(element('p','eyebrow','What-if simulator'),element('h3','',token.name||'Metadata unavailable'),element('p','proof-symbol',token.symbol||'UNKNOWN'));top.append(copy,element('span','go','OPEN LAB →'));
    link.append(top,element('p','footer-note','Canonical curve events · chain Transfer logs · RPC balance · GeckoTerminal price'));
    return link;
  });
  if(items.length)directory.replaceChildren(...items);
}

async function boot() {
  document.documentElement.classList.add('ready');
  revealOnScroll();
  wirePremiumTilt();
  wireLivingMascot();
  wireSimulator();
  wireCopyButtons();
  wireActivityTabs();
  loadMarket();
  void wireAccount();

  const { feed, error } = await readFeed();
  const state = reduceSourceState({ feed, error });
  paintStatus(state, feed);
  paintGrid(feed);
  wireLaunchSearch(feed, state);
  wireLaunchpad(feed, state);
  paintTokenPage(feed);
  paintDynamicTokenPage(feed, state);
  paintAccountSimulator(feed,state);
}

boot();
