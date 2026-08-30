import {Router,Response} from 'express';
import {AccountAuthService,cookieValue,expireCookie,secureCookie} from './accountAuth';
import {FixedWindowRateLimit} from './webhookRateLimit';
const sessionCookie='__Host-ponsr_session',pendingCookie='__Host-ponsr_oauth_pending',csrfCookie='__Host-ponsr_csrf';
const noStore=(res:Response)=>{res.set('Cache-Control','private, no-store');res.set('Pragma','no-cache');res.set('Vary','Cookie, Origin');};
export function accountRouter(service:AccountAuthService){
  const r=Router(),startLimit=new FixedWindowRateLimit(60,60_000);r.use((_req,res,next)=>{noStore(res);next()});
  r.get('/ready',(_req,res)=>res.json({state:service.readiness()?'ready':'unavailable',siteOrigin:service.siteOrigin(),executionAuthority:'NONE_PREVIEW_ONLY'}));
  r.post('/auth/x/start',(req,res)=>{try{service.assertOrigin(req.get('origin'));const limit=startLimit.check();if(!limit.allowed){res.set('Retry-After',String(limit.resetInSeconds));return res.status(429).json({state:'error',problem:'rate_limited'});}const started=service.start(req.get('origin'));if(started.state!=='ready')return res.status(503).json(started);res.setHeader('Set-Cookie',secureCookie(pendingCookie,started.pending,600));return res.json({state:'ready',authorizationUrl:started.authorizationUrl});}catch{return res.status(403).json({state:'error',problem:'request_rejected'});}});
  r.get('/auth/x/callback',async(req,res)=>{try{const result:any=await service.callback({pending:cookieValue(req.get('cookie'),pendingCookie),state:String(req.query.state||''),code:String(req.query.code||'')});if(result.state!=='authenticated'){res.setHeader('Set-Cookie',expireCookie(pendingCookie));return res.redirect(303,'/account/?auth=unavailable');}res.setHeader('Set-Cookie',[secureCookie(sessionCookie,result.token,28800),`${csrfCookie}=${result.csrf}; Path=/; Secure; SameSite=Strict; Max-Age=28800`,expireCookie(pendingCookie)]);return res.redirect(303,'/account/?auth=complete');}catch{res.setHeader('Set-Cookie',expireCookie(pendingCookie));return res.redirect(303,'/account/?auth=error');}});
  r.get('/account/session',(req,res)=>res.json(service.session(cookieValue(req.get('cookie'),sessionCookie))));
  r.get('/account/launches',(req,res)=>{const value:any=service.launches(cookieValue(req.get('cookie'),sessionCookie));return res.status(value.state==='authenticated'?200:401).json(value);});
  r.get('/account/wallet',(req,res)=>{const value:any=service.wallet(cookieValue(req.get('cookie'),sessionCookie));return res.status(value.state==='authenticated'?200:401).json(value);});
  r.post('/auth/logout',(req,res)=>{try{const ok=service.logout(req.get('origin'),cookieValue(req.get('cookie'),sessionCookie),req.get('x-csrf-token'));res.setHeader('Set-Cookie',[expireCookie(sessionCookie),expireCookie(csrfCookie)]);return res.status(ok?200:401).json({state:ok?'unauthenticated':'error'});}catch{return res.status(403).json({state:'error',problem:'request_rejected'});}});
  return r;
}
