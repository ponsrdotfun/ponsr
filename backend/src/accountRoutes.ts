import {Router,Response} from 'express';
import {AccountAuthService,cookieValue,expireCookie,secureCookie} from './accountAuth';
import {FixedWindowRateLimit} from './webhookRateLimit';
import type {AccountClaimService} from './accountClaim';
const sessionCookie='__Host-ponsr_session',pendingCookie='__Host-ponsr_oauth_pending',csrfCookie='__Host-ponsr_csrf';
const noStore=(res:Response)=>{res.set('Cache-Control','private, no-store');res.set('Pragma','no-cache');res.set('Vary','Cookie, Origin');};
export function accountRouter(service:AccountAuthService,claims?:AccountClaimService){
  const r=Router(),startLimit=new FixedWindowRateLimit(60,60_000),claimLimit=new FixedWindowRateLimit(12,60_000);r.use((_req,res,next)=>{noStore(res);next()});
  r.get('/ready',(_req,res)=>res.json({state:service.readiness()?'ready':'unavailable',siteOrigin:service.siteOrigin(),executionAuthority:'NONE_PREVIEW_ONLY'}));
  r.post('/auth/x/start',(req,res)=>{try{service.assertOrigin(req.get('origin'));const limit=startLimit.check();if(!limit.allowed){res.set('Retry-After',String(limit.resetInSeconds));return res.status(429).json({state:'error',problem:'rate_limited'});}const started=service.start(req.get('origin'));if(started.state!=='ready')return res.status(503).json(started);res.setHeader('Set-Cookie',secureCookie(pendingCookie,started.pending,600));return res.json({state:'ready',authorizationUrl:started.authorizationUrl});}catch{return res.status(403).json({state:'error',problem:'request_rejected'});}});
  r.get('/auth/x/callback',async(req,res)=>{try{const result:any=await service.callback({pending:cookieValue(req.get('cookie'),pendingCookie),state:String(req.query.state||''),code:String(req.query.code||'')});if(result.state!=='authenticated'){res.setHeader('Set-Cookie',expireCookie(pendingCookie));return res.redirect(303,'/account/?auth=unavailable');}res.setHeader('Set-Cookie',[secureCookie(sessionCookie,result.token,28800),`${csrfCookie}=${result.csrf}; Path=/; Secure; SameSite=Strict; Max-Age=28800`,expireCookie(pendingCookie)]);return res.redirect(303,'/account/?auth=complete');}catch{res.setHeader('Set-Cookie',expireCookie(pendingCookie));return res.redirect(303,'/account/?auth=error');}});
  r.get('/account/session',(req,res)=>res.json(service.session(cookieValue(req.get('cookie'),sessionCookie))));
  r.get('/account/launches',(req,res)=>{const value:any=service.launches(cookieValue(req.get('cookie'),sessionCookie));return res.status(value.state==='authenticated'?200:401).json(value);});
  r.get('/account/wallet',(req,res)=>{const value:any=service.wallet(cookieValue(req.get('cookie'),sessionCookie));return res.status(value.state==='authenticated'?200:401).json(value);});
  /**
   * Claiming is a WRITE, so it is guarded like one.
   *
   * POST with a CSRF token, matched against the cookie the session already
   * carries -- a claim must never be triggerable by a page the reader did not
   * open. Rate limited because each accepted call spends the treasury's gas,
   * and an attacker who cannot steal can still make Ponsr pay to do nothing.
   *
   * The identity comes from the SESSION. Nothing about who the caller is may be
   * read from the body; `launchId` and `erc20` are the only inputs trusted, and
   * both are checked against the caller's own launches before anything is sent.
   */
  r.post('/account/claim',async(req,res)=>{
    if(!claims)return res.status(503).json({state:'unavailable',detail:'claims_not_configured'});
    try{service.assertOrigin(req.get('origin'));}catch{return res.status(403).json({state:'unavailable',detail:'origin_rejected'});}
    const token=cookieValue(req.get('cookie'),sessionCookie);
    const session:any=service.session(token);
    if(session.state!=='authenticated')return res.status(401).json({state:'unauthenticated'});
    const csrf=req.get('x-csrf-token');
    if(!csrf||csrf!==decodeURIComponent(cookieValue(req.get('cookie'),csrfCookie)||''))return res.status(403).json({state:'unavailable',detail:'csrf_rejected'});
    const limit=claimLimit.check();
    if(!limit.allowed){res.set('Retry-After',String(limit.resetInSeconds));return res.status(429).json({state:'unavailable',detail:'rate_limited'});}
    const outcome:any=await claims.claim({xUserId:session.identity.xUserId,wallet:session.wallet.address,launchId:String(req.body?.launchId||''),erc20:String(req.body?.erc20||'')});
    // A signer refusal is 503 rather than 500: it is a configuration the
    // operator can change, not a fault in this request.
    const status=outcome.state==='sent'?200:outcome.state==='unauthenticated'?401:outcome.state==='not-yours'?403:outcome.state==='signer-refused'?503:409;
    return res.status(status).json(outcome);
  });
  r.post('/auth/logout',(req,res)=>{try{const ok=service.logout(req.get('origin'),cookieValue(req.get('cookie'),sessionCookie),req.get('x-csrf-token'));res.setHeader('Set-Cookie',[expireCookie(sessionCookie),expireCookie(csrfCookie)]);return res.status(ok?200:401).json({state:ok?'unauthenticated':'error'});}catch{return res.status(403).json({state:'error',problem:'request_rejected'});}});
  return r;
}
