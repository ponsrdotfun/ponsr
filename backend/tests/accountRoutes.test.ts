import express from 'express';import * as fs from 'fs';import {AddressInfo} from 'net';import {Db} from '../src/db';import {AccountAuthService} from '../src/accountAuth';import {accountRouter} from '../src/accountRoutes';import {generateMockWallet} from '../src/walletResolver';
describe('Account Phase B HTTP boundary',()=>{let db:Db|undefined,server:any,base:string,dir:string;beforeEach(()=>{dir=fs.mkdtempSync('./data/account-routes-')});afterEach(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));db?.close();fs.rmSync(dir,{recursive:true,force:true});server=undefined;db=undefined});
 async function boot(){db=new Db(`${dir}/db.sqlite`);const wallet=generateMockWallet('123');db.upsertUser('123','alice',{xUserId:'123',walletAddress:wallet.address,providerRef:wallet.providerRef});const service=new AccountAuthService(db,{lookupExistingVerified:async(id)=>db!.getUser(id)},{exchange:async()=>({id:'123',username:'alice'})},{enabled:true,clientId:'client',clientSecret:'secret',callbackUrl:'https://ponsr.fun/api/auth/x/callback',siteOrigin:'https://ponsr.fun',walletContinuityConfigured:true});const app=express();app.use('/api',accountRouter(service));server=app.listen(0);await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;return wallet;}
 it('publishes no-store readiness and rejects cross-origin OAuth start',async()=>{await boot();const ready=await fetch(base+'/api/ready');expect(ready.headers.get('cache-control')).toBe('private, no-store');expect((await ready.json() as any).executionAuthority).toBe('NO_WALLET_AUTHORITY');const denied=await fetch(base+'/api/auth/x/start',{method:'POST',headers:{Origin:'https://evil.example'}});expect(denied.status).toBe(403);expect(JSON.stringify(await denied.json())).not.toMatch(/secret|client/i)});
 it('sets host-only secure cookies, authenticates read-only, and enforces CSRF logout',async()=>{const wallet=await boot();const start=await fetch(base+'/api/auth/x/start',{method:'POST',headers:{Origin:'https://ponsr.fun'}}),body:any=await start.json(),pending=start.headers.get('set-cookie')!;expect(pending).toMatch(/__Host-ponsr_oauth_pending=.*HttpOnly; Secure; SameSite=Lax/);const state=new URL(body.authorizationUrl).searchParams.get('state');const callback=await fetch(`${base}/api/auth/x/callback?state=${state}&code=once`,{headers:{Cookie:pending.split(';')[0]},redirect:'manual'});expect(callback.status).toBe(303);const raw=(callback.headers as any).getSetCookie() as string[];expect(raw.join(';')).toMatch(/__Host-ponsr_session=.*HttpOnly; Secure/);const sessionCookie=raw.find(x=>x.startsWith('__Host-ponsr_session='))!.split(';')[0],csrfCookie=raw.find(x=>x.startsWith('__Host-ponsr_csrf='))!.split(';')[0],csrf=csrfCookie.split('=')[1];const value:any=await (await fetch(base+'/api/account/session',{headers:{Cookie:sessionCookie}})).json();expect(value.wallet.address).toBe(wallet.address);expect(value).toMatchObject({executionAuthority:'NO_WALLET_AUTHORITY',canSign:false,canSend:false,canSwap:false,canClaim:false});expect(JSON.stringify(value)).not.toContain(wallet.providerRef);expect((await fetch(base+'/api/auth/logout',{method:'POST',headers:{Origin:'https://ponsr.fun',Cookie:`${sessionCookie}; ${csrfCookie}`,'X-CSRF-Token':'wrong'}})).status).toBe(401);expect((await fetch(base+'/api/auth/logout',{method:'POST',headers:{Origin:'https://ponsr.fun',Cookie:`${sessionCookie}; ${csrfCookie}`,'X-CSRF-Token':csrf}})).status).toBe(200);expect((await (await fetch(base+'/api/account/session',{headers:{Cookie:sessionCookie}})).json() as any).state).toBe('unauthenticated')});
});

/**
 * A PUBLIC FIELD MUST NOT CLAIM THE PRODUCT IS SOMETHING IT STOPPED BEING.
 *
 * `/ready` and the session endpoints published `NONE_PREVIEW_ONLY`. Half of
 * that was true and stayed true: this site holds no key over the reader's
 * wallet and asks them for no signature. The other half stopped being true on
 * 2026-09-01, when the owner collected real fees from these pages -- a preview
 * does not move value.
 *
 * The replacement says only the part that is true. The assertion is here so the
 * old string cannot drift back in, in either half of the codebase.
 */
describe('the execution-authority field', () => {
  it('says what is still true and nothing that is not', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '../..');
    const files = [
      'backend/src/accountAuth.ts',
      'backend/src/accountRoutes.ts',
      'website/assets/app.mjs',
      'scripts/build-website.mjs',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toContain('NONE_PREVIEW_ONLY');
    }
    // And the value that replaced it is still asserted somewhere, so deleting
    // the field entirely does not pass this test by absence.
    expect(fs.readFileSync(path.join(root, 'backend/src/accountRoutes.ts'), 'utf8')).toContain(
      'NO_WALLET_AUTHORITY'
    );
  });
});
