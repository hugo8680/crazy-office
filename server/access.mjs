import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const scrypt=promisify(scryptCallback);
const COOKIE='__Host-office_session',SESSION_SECONDS=12*60*60;
const WINDOW_MS=15*60*1000,MAX_FAILURES=8,MAX_CLIENTS=10000;
const SCRYPT={N:16384,r:8,p:1,maxmem:64*1024*1024};
const failure=(message,status=401,extra={})=>Object.assign(new Error(message),{status,statusCode:status,...extra});
const equalText=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());

function decode(value,length){
  if(typeof value!=='string'||!value||!/^[-_A-Za-z0-9]+$/.test(value))return null;
  const bytes=Buffer.from(value,'base64url');
  return bytes.length===length&&bytes.toString('base64url')===value?bytes:null;
}
function parseHash(value){
  if(typeof value!=='string')return null;
  const fields=value.split('$');
  if(fields.length!==6||fields[0]!=='scrypt'||fields[1]!=='16384'||fields[2]!=='8'||fields[3]!=='1')return null;
  const salt=decode(fields[4],16),key=decode(fields[5],64);return salt&&key?{salt,key}:null;
}
function clientAddress(req){
  const remote=String(req?.socket?.remoteAddress||'unknown').toLowerCase();
  const normalized=remote.startsWith('::ffff:')?remote.slice(7):remote;
  const loopback=remote==='::1'||(/^127\./.test(normalized)&&isIP(normalized)===4);
  const forwarded=req?.headers?.['x-real-ip'];
  return loopback&&typeof forwarded==='string'&&isIP(forwarded.trim())?forwarded.trim().toLowerCase():remote;
}
function cookieToken(req){
  const header=req?.headers?.cookie;
  if(typeof header!=='string'||header.length>8192)return null;
  const matches=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(COOKIE+'='));
  return matches.length===1?matches[0].slice(COOKIE.length+1):null;
}

export async function hashAccessPassword(password){
  if(typeof password!=='string'||password.length<12||Buffer.byteLength(password,'utf8')>1024)throw new Error('访问密码需要至少12个字符，且不超过1024字节。');
  const salt=randomBytes(16),key=await scrypt(password,salt,64,SCRYPT);
  return ['scrypt',SCRYPT.N,SCRYPT.r,SCRYPT.p,salt.toString('base64url'),key.toString('base64url')].join('$');
}

export function createAccessGate({env=process.env,now=Date.now,identity=null}={}){
  const originValue=String(env.OFFICE_PUBLIC_ORIGIN||'').trim();let publicOrigin='';
  if(originValue){
    let url;try{url=new URL(originValue);}catch{throw new Error('OFFICE_PUBLIC_ORIGIN需要有效的HTTPS来源地址。');}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('OFFICE_PUBLIC_ORIGIN仅接受HTTPS来源地址，不含路径或账号密码。');
    publicOrigin=url.origin;
  }
  const enabled=Boolean(publicOrigin||env.OFFICE_ACCESS_PASSWORD_HASH);
  const username=String(env.OFFICE_ACCESS_USERNAME||env.OFFICE_ACCESS_USER||'office');
  let passwordHash,secret;
  if(enabled){
    passwordHash=parseHash(env.OFFICE_ACCESS_PASSWORD_HASH);
    if(!passwordHash)throw new Error('公网访问必须配置有效的OFFICE_ACCESS_PASSWORD_HASH。');
    if(typeof env.OFFICE_SESSION_SECRET!=='string'||Buffer.byteLength(env.OFFICE_SESSION_SECRET,'utf8')<32||!env.OFFICE_SESSION_SECRET.trim())throw new Error('OFFICE_SESSION_SECRET至少需要32字节。');
    if(!/^[A-Za-z0-9_.@-]{1,80}$/.test(username))throw new Error('访问账号只接受1到80位字母、数字、点、下划线、@或短横线。');
    secret=Buffer.from(env.OFFICE_SESSION_SECRET,'utf8');
  }
  const clients=new Map();
  const sign=body=>createHmac('sha256',secret).update(body).digest();
  const cookie=value=>`${COOKIE}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict`;
  function authenticate(req){
    if(!enabled){const actor=identity?.resolveLegacy(null);return identity?(actor?{...actor,expiresAt:null}:null):{username:null,expiresAt:null};}
    const token=cookieToken(req);if(!token||token.length>2048)return null;
    const pieces=token.split('.');if(pieces.length!==2)return null;
    const [body,signature]=pieces,key=decode(signature,32);
    if(!key||!/^[-_A-Za-z0-9]+$/.test(body)||!timingSafeEqual(sign(body),key))return null;
    let session;try{session=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return null;}
    const current=Math.floor(now()/1000);
    if(![1,2].includes(session?.v)||!Number.isInteger(session.iat)||!Number.isInteger(session.exp)||session.iat>current+60||session.exp-session.iat!==SESSION_SECONDS||session.exp<=current||typeof session.nonce!=='string'||!decode(session.nonce,16))return null;
    const expiresAt=new Date(session.exp*1000).toISOString();
    if(session.v===1){if(session.sub!==username)return null;const actor=identity?.resolveLegacy(username);return identity?(actor?{...actor,expiresAt}:null):{username,expiresAt};}
    if(!identity||typeof session.sub!=='string'||session.sub.length>80||!Number.isSafeInteger(session.epoch)||session.epoch<1)return null;
    const actor=identity.resolveSession({id:session.sub,epoch:session.epoch});return actor?{...actor,expiresAt}:null;
  }
  function publicSession(req){const user=authenticate(req);return {enabled,authenticated:Boolean(user),...(user||{}),...(identity&&user?{actor:user}:{})};}
  function bucketFor(address){
    const cutoff=now()-WINDOW_MS;
    for(const [key,bucket] of clients){bucket.failures=bucket.failures.filter(time=>time>cutoff);if(!bucket.failures.length&&!bucket.pending&&bucket.updatedAt<=cutoff)clients.delete(key);}
    let bucket=clients.get(address);
    if(!bucket){
      if(clients.size>=MAX_CLIENTS)throw failure('登录请求过多，请稍后再试。',429,{retryAfter:60});
      bucket={failures:[],pending:0,updatedAt:now()};clients.set(address,bucket);
    }
    bucket.updatedAt=now();return bucket;
  }
  async function login(req,credentials){
    if(!enabled)return {cookie:null,session:publicSession(req)};
    if(publicOrigin&&req?.headers?.origin!==publicOrigin)throw failure('登录请求来源无效。',403);
    const bucket=bucketFor(clientAddress(req));
    if(bucket.failures.length+bucket.pending>=MAX_FAILURES){const reset=(bucket.failures[0]??now())+WINDOW_MS;throw failure('登录尝试过多，请15分钟后重试。',429,{retryAfter:Math.max(1,Math.ceil((reset-now())/1000))});}
    bucket.pending++;
    try{
      const validShape=credentials&&typeof credentials.username==='string'&&credentials.username.length<=80&&typeof credentials.password==='string'&&Buffer.byteLength(credentials.password,'utf8')<=1024;
      // A wrong account still performs the same password derivation. Neither
      // credentials nor the configured key are returned or written to disk.
      const supplied=validShape?credentials.password:'invalid-credential-placeholder';
      let actor=null,accepted=false;
      if(identity&&(!validShape||!equalText(credentials.username,username))){
        actor=await identity.authenticate(validShape?credentials:{});accepted=Boolean(actor);
      }else{
        const candidate=await scrypt(supplied,passwordHash.salt,64,SCRYPT);
        accepted=Boolean(validShape&&equalText(credentials.username,username)&&timingSafeEqual(candidate,passwordHash.key));
        if(accepted&&identity){actor=identity.resolveLegacy(username);accepted=Boolean(actor);}
      }
      if(!accepted){bucket.failures.push(now());bucket.updatedAt=now();throw failure('账号或密码错误。');}
      bucket.failures=[];bucket.updatedAt=now();
      const issued=Math.floor(now()/1000),body=Buffer.from(JSON.stringify({v:actor?.source==='employee'?2:1,sub:actor?.source==='employee'?actor.id:username,...(actor?.source==='employee'?{epoch:actor.epoch}:{}),iat:issued,exp:issued+SESSION_SECONDS,nonce:randomBytes(16).toString('base64url')})).toString('base64url');
      const value=body+'.'+sign(body).toString('base64url');
      const user={...(actor||{username}),expiresAt:new Date((issued+SESSION_SECONDS)*1000).toISOString()};
      return {cookie:cookie(value),session:{enabled:true,authenticated:true,...user,...(identity?{actor:user}:{})}};
    }finally{bucket.pending--;}
  }
  return {enabled,authenticate,login,publicSession,logoutCookie:()=>`${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`};
}
