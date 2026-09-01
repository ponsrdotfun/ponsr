import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { Db } from './db';
import { ResolvedWallet } from './types';

const b64=(b:Buffer)=>b.toString('base64url');
const random=()=>b64(crypto.randomBytes(32));
export const hashSecret=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
export const numericXId=(v:unknown)=>/^\d{1,24}$/.test(String(v||''))?String(v):null;
export const secureCookie=(name:string,value:string,maxAge:number)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const expireCookie=(name:string)=>`${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export interface AccountAuthConfig { enabled:boolean; clientId:string; clientSecret:string; callbackUrl:string; siteOrigin:string; walletContinuityConfigured:boolean; }
export interface XIdentity { id:string; username:string; }
export interface AccountOAuthProvider { exchange(code:string,verifier:string,callbackUrl:string):Promise<XIdentity>; }
export interface ExistingWalletVerifier { lookupExistingVerified(xUserId:string):Promise<ResolvedWallet|null>; }

export class XOAuthProvider implements AccountOAuthProvider {
  constructor(private clientId:string,private clientSecret:string,private fetchImpl:typeof fetch=fetch){}
  async exchange(code:string,verifier:string,callbackUrl:string):Promise<XIdentity>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callbackUrl,code_verifier:verifier});
      const token=await this.fetchImpl('https://api.x.com/2/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body,signal:controller.signal});
      if(!token.ok)throw new Error('X token exchange failed');
      const access=String((await token.json() as any)?.access_token||'');if(!access)throw new Error('X access token missing');
      const me=await this.fetchImpl('https://api.x.com/2/users/me?user.fields=username',{headers:{Authorization:`Bearer ${access}`},signal:controller.signal});
      if(!me.ok)throw new Error('X identity verification failed');
      const data=(await me.json() as any)?.data,id=numericXId(data?.id),username=String(data?.username||'');
      if(!id||!/^[_A-Za-z0-9]{1,15}$/.test(username))throw new Error('X returned malformed identity');
      return{id,username};
    }finally{clearTimeout(timer);}
  }
}

export class AccountAuthService {
  constructor(private db:Db,private wallets:ExistingWalletVerifier,private provider:AccountOAuthProvider,private config:AccountAuthConfig,private now:()=>Date=()=>new Date()){}
  siteOrigin(){try{return new URL(this.config.siteOrigin).origin;}catch{return '';}}
  readiness(){try{const callback=new URL(this.config.callbackUrl),site=new URL(this.config.siteOrigin);return this.config.enabled&&this.config.walletContinuityConfigured&&!!this.config.clientId&&!!this.config.clientSecret&&callback.protocol==='https:'&&site.protocol==='https:'&&callback.origin===site.origin&&callback.pathname==='/api/auth/x/callback'&&!callback.search&&!callback.hash&&site.pathname==='/'&&!site.search&&!site.hash;}catch{return false;}}
  assertOrigin(origin:string|undefined){if(origin!==this.siteOrigin())throw new Error('origin rejected');}
  start(origin:string|undefined){this.assertOrigin(origin);if(!this.readiness())return{state:'unavailable' as const};const pending=random(),state=random(),verifier=random(),challenge=b64(crypto.createHash('sha256').update(verifier).digest()),now=this.now(),expires=new Date(now.getTime()+10*60_000);this.db.createOAuthPending({tokenHash:hashSecret(pending),stateHash:hashSecret(state),verifier,expiresAt:expires.toISOString()});const q=new URLSearchParams({response_type:'code',client_id:this.config.clientId,redirect_uri:this.config.callbackUrl,scope:'users.read tweet.read',state,code_challenge:challenge,code_challenge_method:'S256'});return{state:'ready' as const,authorizationUrl:`https://twitter.com/i/oauth2/authorize?${q}`,pending};}
  async callback(input:{pending?:string;state?:string;code?:string}){if(!this.readiness())return{state:'unavailable' as const};if(!input.pending||!input.state)return{state:'error' as const,problem:'invalid_callback'};const now=this.now(),pending=this.db.consumeOAuthPending(hashSecret(input.pending),hashSecret(input.state),now.toISOString());if(!pending)return{state:'error' as const,problem:'invalid_or_replayed_state'};if(!input.code)return{state:'error' as const,problem:'invalid_callback'};const identity=await this.provider.exchange(input.code,pending.pkce_verifier,this.config.callbackUrl),xUserId=numericXId(identity.id);if(!xUserId)return{state:'error' as const,problem:'invalid_identity'};const wallet=await this.wallets.lookupExistingVerified(xUserId);if(!wallet)return{state:'unavailable' as const,problem:'existing_wallet_not_found'};const token=random(),csrf=random(),expires=new Date(now.getTime()+8*60*60_000);this.db.createAccountSession({tokenHash:hashSecret(token),csrfHash:hashSecret(csrf),xUserId,xHandle:identity.username,walletAddress:ethers.getAddress(wallet.walletAddress),providerRef:wallet.providerRef,verifiedAt:now.toISOString(),expiresAt:expires.toISOString()});return{state:'authenticated' as const,token,csrf,expiresAt:expires.toISOString()};}
  session(token?:string){if(!token)return{state:'unauthenticated' as const};const now=this.now(),row=this.db.getAccountSession(hashSecret(token),now.toISOString(),new Date(now.getTime()-30*60_000).toISOString());if(!row)return{state:'unauthenticated' as const};return{state:'authenticated' as const,session:{expiresAt:row.expires_at,idleTimeoutMinutes:30,csrfRequired:true},identity:{xUserId:row.x_user_id,handle:row.x_handle,verifiedAt:row.verified_at},wallet:{address:ethers.getAddress(row.wallet_address),provider:'privy',continuity:'existing-verified'},executionAuthority:'NO_WALLET_AUTHORITY',canSign:false,canSend:false,canSwap:false,canClaim:false};}
  logout(origin:string|undefined,token?:string,csrf?:string){this.assertOrigin(origin);if(!token||!csrf)return false;return this.db.revokeAccountSession(hashSecret(token),hashSecret(csrf),this.now().toISOString());}
  launches(token?:string){const s:any=this.session(token);return s.state==='authenticated'?{state:'authenticated',launches:this.db.listLaunchesForUser(s.identity.xUserId),executionAuthority:'NO_WALLET_AUTHORITY'}:{state:'unauthenticated'};}
  wallet(token?:string){const s:any=this.session(token);return s.state==='authenticated'?{state:'authenticated',wallet:s.wallet,executionAuthority:'NO_WALLET_AUTHORITY',canSign:false,canSend:false,canSwap:false,canClaim:false}:{state:'unauthenticated'};}
}

export function cookieValue(header:string|undefined,name:string){for(const part of String(header||'').split(';')){const [k,...v]=part.trim().split('=');if(k===name)return v.join('=');}return undefined;}
