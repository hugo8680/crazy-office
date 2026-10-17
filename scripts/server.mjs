import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { OfficeEngine } from '../server/engine.mjs';
import { publicCatalog, getScenario } from '../server/catalog.mjs';
import { getProviderStatus } from '../server/provider.mjs';
import { createNetworkPolicy } from '../server/network.mjs';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const root=resolve(projectRoot,'dist');
const port=Number(process.env.PORT||4173);
const bindHost=process.env.HOST||'0.0.0.0';
const networkPolicy=createNetworkPolicy({port,bindHost});
const engine=new OfficeEngine({dataDir:resolve(projectRoot,'.office-data')});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){
  let total=0;const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>12*1024*1024)throw Object.assign(new Error('输入文件超过12MB限制。'),{status:413});chunks.push(chunk);}
  if(!total)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('请求需要有效的JSON输入。'),{status:400});}
}
const server=createServer(async(req,res)=>{
  const rejected=networkPolicy.validateRequest(req);
  if(rejected){json(res,rejected.status,{error:rejected.error});return;}
  if(!['GET','HEAD','POST'].includes(req.method)){res.writeHead(405).end();return;}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname.startsWith('/api/')){
      if(pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,provider:await getProviderStatus(),activeRuns:(await engine.list()).filter(r=>['queued','running','awaiting_approval'].includes(r.status)).length});
      if(pathname==='/api/catalog'&&req.method==='GET')return json(res,200,publicCatalog());
      if(pathname==='/api/provider/check'&&req.method==='POST')return json(res,200,{provider:await getProviderStatus({refresh:true})});
      if(pathname==='/api/runs'&&req.method==='GET')return json(res,200,{runs:await engine.list()});
      if(pathname==='/api/runs'&&req.method==='POST')return json(res,202,{run:await engine.create(await body(req))});
      const example=pathname.match(/^\/api\/examples\/([a-z]+)$/);
      if(example&&req.method==='GET'){
        if(!getScenario(example[1]))return json(res,404,{error:'示例不存在。'});
        const data=JSON.parse(await readFile(resolve(projectRoot,'data/examples',example[1]+'.json'),'utf8'));
        return json(res,200,{input:{...(data.input||data),example:true}});
      }
      const matched=pathname.match(/^\/api\/runs\/([a-z0-9-]+)(?:\/(events|approval|cancel|retry|artifacts)(?:\/([^/]+))?)?$/i);
      if(matched){
        const [,id,action,artifactId]=matched;
        if(!action&&req.method==='GET')return json(res,200,{run:engine.publicRun(await engine.get(id))});
        if(action==='events'&&req.method==='GET'){
          const run=await engine.get(id);res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          const send=state=>{if(!res.destroyed)res.write('event: state\ndata: '+JSON.stringify({run:state})+'\n\n');};send(engine.publicRun(run));engine.on('run:'+id,send);
          const timer=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000);req.on('close',()=>{clearInterval(timer);engine.off('run:'+id,send);});return;
        }
        if(action==='approval'&&req.method==='POST')return json(res,200,{run:await engine.approve(id,await body(req))});
        if(action==='cancel'&&req.method==='POST')return json(res,200,{run:await engine.cancel(id)});
        if(action==='retry'&&req.method==='POST')return json(res,202,{run:await engine.retry(id)});
        if(action==='artifacts'&&artifactId&&req.method==='GET'){
          const artifact=await engine.artifact(id,artifactId),bytes=await readFile(artifact.path);
          res.writeHead(200,{'Content-Type':artifact.mimeType||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="download${extname(artifact.name).replace(/[^.a-z0-9]/gi,'')}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`});res.end(bytes);return;
        }
      }
      return json(res,404,{error:'接口不存在。'});
    }
    const requested=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!requested.startsWith(root+sep))return void res.writeHead(403).end('Forbidden');
    const info=await stat(requested);if(!info.isFile())throw Object.assign(new Error('文件不存在。'),{status:404});
    const data=await readFile(requested);res.writeHead(200,{'Content-Type':types[extname(requested)]||'application/octet-stream','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:data);
  }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.code==='ENOENT'?'文件或示例不存在。':String(error.message||'服务异常').slice(0,1600)});else res.end();}
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(port,bindHost,()=>{
  const urls=networkPolicy.urls();
  if(urls.local)console.log(`Office: ${urls.local}`);
  if(urls.lanName)console.log(`Office LAN name (preferred): ${urls.lanName}`);
  for(const url of urls.lan)console.log(`Office LAN: ${url}`);
  if(!urls.local&&!urls.lan.length)console.log(`Office listening on ${bindHost}:${port}`);
});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
