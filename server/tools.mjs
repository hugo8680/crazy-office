import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AGENTS} from './catalog.mjs';
import {INVESTMENT_TOOL_DEFINITIONS,createInvestmentFunctions} from './investment.mjs';
import {ONBOARDING_TOOL_DEFINITIONS,createOnboardingFunctions} from './onboarding.mjs';
import {reportDocument} from './report-document.mjs';

const projectDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PYTHON=process.env.OFFICE_PYTHON || '/usr/bin/python3';
const obj=properties=>({type:'object',properties,additionalProperties:false});
const str=description=>({type:'string',description});
const num=description=>({type:'number',description});
const strings=description=>({type:'array',items:{type:'string'},description});
const defs=[
 ['import_finance','导入本次用户的CSV/XLSX/JSON财务数据到真实SQLite，严格校验两年各12月、重复、金额、现金平衡。默认使用本次输入，不必复述文件。',obj({year:num('可省略，使用任务年度')})],
 ['calculate_finance','读取已导入SQLite，用分为单位确定性计算两年营收、毛利、经营利润、净利润、现金与同比，生成XLSX/CSV/HTML/JSON。不可心算。',obj({})],
 ['audit_finance','从原始SQLite独立重算并检查完整性、现金平衡和口径，不依赖分析Agent尚未生成的文件。',obj({})],
 ['search_web','真实HTTP检索公开网页，返回服务器供应商候选链接及搜索证据。搜索摘要不能代替正式报价；随后必须fetch_quote抓取。默认使用用户检索词，保留用户全部候选链接。',obj({query:str('真实检索词'),limit:{type:'integer',minimum:1,maximum:8,description:'最多8个候选；默认8'}})],
 ['fetch_quote','实时抓取公开供应商URL，提取标价/币种/配置片段与证据。只能public HTTP(S)，私网/回环/重定向均校验。页面缺价、受阻或动态加载明确待询价，绝不编价。可单URL或最多8个URLs。',obj({url:str('供应商产品或公开报价页面URL'),urls:strings('待逐项抓取的候选URL，最多8个')})],
 ['compare_quotes','按真实抓取报价对照币种、标价、配置与税费保修的未知项。默认比较全部已抓取；不跨币种换算、不宣称全网最低、不自动证明配置等价。',obj({purpose:str('technical配置审查 / budget成本核对 / management综合审查'),notes:str('根据证据的审查意见，不能补造缺失价格或配置')})],
 ['inspect_network','读取本次上传日志，真实解析来源、请求、时间窗及状态；仅隔离工作区，不扫描或改变网络。',obj({})],
 ['analyze_traffic','真实聚合请求日志，按滑动时间窗计算高频来源和路径证据。高频不自动等于攻击。',obj({threshold:{type:'integer',minimum:1,maximum:100000},windowSeconds:{type:'integer',minimum:1,maximum:3600}})],
 ['apply_defense','根据证据提交明确IP封禁和/或每来源速率策略。必须等待真人批准；拒绝则只保留方案。在run工作区生成规则与nginx片段，绝不修改主机防火墙。',obj({blockedIps:strings('明确选择的IP数组；无封禁时传[]'),rateLimit:{type:['integer','null'],minimum:1,maximum:100000,description:'每个IP每时间窗允许的请求数；不做限速则null'},windowSeconds:{type:'integer',minimum:1,maximum:3600},reason:str('引用流量证据并解释误伤风险')})],
 ['verify_network','独立重放实际输入日志，计算正常请求放行、攻击拦截与误伤。没有真值标签就明确不能确认恢复；审批拒绝也照实验收。',obj({})],
 ['design_database','将模型设计的SQLite DDL存为SQL并在内存真实执行验证。只允许CREATE TABLE/INDEX，禁止扩展、ATTACH、虚拟表和文件访问。',obj({ddl:str('完整SQLite CREATE TABLE/CREATE INDEX DDL；用分号分隔。须符合实际需求的约束。'),description:str('实体关系与字段说明'),assumptions:strings('需求未明确而作出的假设')})],
 ['build_database','执行已验证DDL，在隔离工作区真实建立SQLite；默认导入用户数据（JSON表名映射或CSV）。无数据可建空库，可额外传明确验证样本INSERT，禁止混入用户数据。',obj({table:str('CSV/行数组多表导入时的表名'),sampleSql:str('仅无用户数据时可选的INSERT验证样本；明确标记非业务数据')})],
 ['test_database','真实检查SQLite完整性/外键与结构，并自动独立复跑input.databaseChecks。已有合同不必重复传tests；可传tests:[]和queries。附加正反用例可用setupSql准备本用例前置数据，不能把已回滚合同ID当现存样本；期望约束拒绝用expectError:true。queries只允许SELECT，全部测试变更回滚。',obj({tests:{type:'array',maxItems:30,items:obj({name:str('验收条件'),setupSql:str('可选，本用例SQL执行前的准备语句，完成后一起回滚；准备失败不能算约束通过'),sql:str('INSERT/UPDATE/DELETE/SELECT测试SQL'),expectError:{type:'boolean'},expectedRows:{type:'integer'},params:{type:'array',items:{type:['string','number','null']}}})},queries:{type:'array',maxItems:10,items:{type:'string'}}})],
 ['extract_requirements','基于用户原始需求提取可追溯要求，保存规格和验收清单。每项source必须逐字引用用户材料；原文有多个R数字编号时，保留并覆盖全部原编号，source必须来自同编号业务条款，不能以背景或共同交付说明替代；额外共同要求可另列新ID。不凭空添加确认事项。',obj({requirements:{type:'array',items:obj({id:str('R1等唯一ID，原文已有编号须保留'),description:str('需求内容'),source:str('从对应需求条款逐字引用的证据'),acceptance:str('可核验验收条件')})},entities:strings('数据实体/业务对象'),questions:strings('待真人确认的问题'),exclusions:strings('本次排除范围'),assumptions:strings('明确标记假设')})],
 ['estimate_delivery','保存模型拆解的工作包并确定性计算人日、依赖排期与成本。首次须给packages；财务复核不传packages，复用同事已保存工作包，避免重造。每天可用人数用teamSize，默认1。估算不是合同报价。',obj({packages:{type:'array',maxItems:50,items:obj({id:str('唯一工作包ID'),name:str('工作包'),days:num('所需人日，大于0'),dependsOn:strings('依赖的工作包ID数组'),requirementIds:strings('覆盖的需求ID'),deliverable:str('可验收产物')})},dailyRate:num('可省略，使用用户人日单价'),teamSize:{type:'integer',minimum:1,maximum:50},bufferPct:{type:'number',minimum:0,maximum:100},assumptions:strings('估算假设')})],
 ['review_delivery','独立核对原始需求引用、工作包依赖、人日与费用一致性及验收覆盖。返回实际检查结果；issues为审校Agent补充的发现，不能伪称客户确认。',obj({issues:strings('审校Agent根据证据发现的范围或估算问题'),risks:strings('待确认风险')})],
 ['write_report','把基于同事证据的中文正式汇报保存为可下载Markdown及HTML。content须含真实结果/限制/来源，不能伪造数据、客户承诺或生产修复。',obj({title:str('报告标题'),content:str('完整中文Markdown正文；工具返回文件不代替正文')})],
 ['list_artifacts','列出本次实际文件及相关结构化工具结果，供同事复核，不返回私密凭证或工作区外路径。',obj({})],
];
export const TOOL_DEFINITIONS=[...defs.map(([name,description,parameters])=>({name,description,parameters})),...INVESTMENT_TOOL_DEFINITIONS,...ONBOARDING_TOOL_DEFINITIONS];
const mime={'.json':'application/json','.csv':'text/csv; charset=utf-8','.md':'text/markdown; charset=utf-8','.html':'text/html; charset=utf-8','.txt':'text/plain; charset=utf-8','.sql':'application/sql','.conf':'text/plain; charset=utf-8','.sqlite':'application/vnd.sqlite3','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const decode=s=>String(s).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const plain=s=>decode(String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')).trim();
const csvCell=c=>{let v=String(c??'');if(typeof c==='string'&&/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"';};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function isPublicAddress(address){
 const ip=address.replace(/^\[|\]$/g,''); const type=net.isIP(ip);
 if(type===4){const a=ip.split('.').map(Number);const [x,y]=a;return !(x===0||x===10||x===127||x>=224||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&(y===168||y===0))||(x===198&&(y===18||y===19||y===51))||(x===203&&y===0&&a[2]===113));}
 if(type===6){ const p=ip.toLowerCase();return /^[23][0-9a-f]{0,3}:/.test(p)&&!p.startsWith('2001:db8:')&&!p.startsWith('2001:0:')&&!p.startsWith('2002:'); }
 return false;
}
export function isDirectlyConnectedAddress(address,interfaces=os.networkInterfaces()){
 const value=String(address).replace(/^\[|\]$/g,'');const family=net.isIP(value);
 const v4=s=>String(s).split('.').reduce((n,p)=>((n<<8)|Number(p))>>>0,0);
 const normalize=s=>{try{return new URL('http://['+String(s).split('%')[0]+']/').hostname.slice(1,-1);}catch{return String(s);}};
 for(const nic of Object.values(interfaces||{}).flat()){
  if(!nic?.address)continue;const nicFamily=nic.family===4||nic.family==='IPv4'?4:nic.family===6||nic.family==='IPv6'?6:net.isIP(nic.address);
  if(family!==nicFamily)continue;
  if(family===4){if(value===nic.address)return true;if(typeof nic.netmask==='string'&&net.isIP(nic.netmask)===4){const mask=v4(nic.netmask);if(mask!==0&&(v4(value)&mask)===(v4(nic.address)&mask))return true;}}
  if(family===6&&normalize(value)===normalize(nic.address))return true;
 }
 return false;
}
export async function validatePublicUrl(value,{networkInterfaces=os.networkInterfaces()}={}){
 let u;try{u=new URL(String(value));}catch{throw new Error('无效的互联网URL');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('仅允许无账号密码的HTTP(S)公开URL');
 if(u.port&&!['80','443'].includes(u.port))throw new Error('仅允许公开网页80/443端口');
 const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(!host||host==='localhost'||/\.(?:localhost|local|internal|test|invalid)$/.test(host)||host==='metadata.google.internal')throw new Error('拒绝内网或本机URL');
 const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await dns.lookup(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)||isDirectlyConnectedAddress(a.address,networkInterfaces)))throw new Error('拒绝解析到非公开地址的URL');
 return {url:u,addresses};
}
let proxyCache;
async function systemProxy(){
 const explicit=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
 if(explicit){let p;try{p=new URL(explicit);}catch{throw new Error('HTTP代理配置无效');}if(!['http:','https:'].includes(p.protocol))throw new Error('仅支持HTTP(S)代理');return p.href;}
 if(process.platform!=='darwin')return null;
 if(proxyCache!==undefined)return proxyCache;
 proxyCache=await new Promise(resolve=>{let out='';const c=spawn('/usr/sbin/scutil',['--proxy'],{stdio:['ignore','pipe','ignore']});const timer=setTimeout(()=>{c.kill();resolve(null);},2500);c.stdout.on('data',b=>out+=b.toString());c.on('error',()=>{clearTimeout(timer);resolve(null);});c.on('close',()=>{clearTimeout(timer);const enabled=out.match(/HTTPSEnable\s*:\s*(\d+)/)?.[1];const host=out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];const port=out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];resolve(enabled==='1'&&host&&port?'http://'+host+':'+port:null);});});
 return proxyCache;
}
async function curlPinned(url,addresses,proxy,{signal,maxBytes}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'office-public-fetch-'));const headers=path.join(dir,'headers');const addr=addresses.find(a=>a.family===4)||addresses[0];const port=url.port||(url.protocol==='https:'?'443':'80');const ip=addr.family===6?'['+addr.address+']':addr.address;
 try{return await new Promise((resolve,reject)=>{const args=['--silent','--show-error','--proxy',proxy,'--noproxy','','--proxytunnel','--connect-to',url.hostname+':'+port+':'+ip+':'+port,'--proto','=http,https','--connect-timeout','8','--max-time','20','--max-filesize',String(maxBytes),'--dump-header',headers,'--output','-','--header','Accept-Encoding: identity','--user-agent','Mozilla/5.0 (compatible; OfficeAgentLab/1.0)',url.href];const c=spawn('/usr/bin/curl',args,{stdio:['ignore','pipe','pipe']});const chunks=[];let size=0,err='',done=false;const finish=(e,v)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);e?reject(e):resolve(v);};const abort=()=>{c.kill('SIGKILL');finish(new Error('任务已取消'));};signal?.addEventListener('abort',abort,{once:true});c.stdout.on('data',b=>{size+=b.length;if(size>maxBytes){c.kill();finish(new Error('网页超过抓取上限'));}else chunks.push(b);});c.stderr.on('data',b=>err=(err+b.toString()).slice(-1000));c.on('error',()=>finish(new Error('公开网页抓取程序启动失败')));c.on('close',async code=>{if(done)return;if(code!==0){finish(new Error('公开网页抓取失败（curl '+code+'）'+(err.includes('timed out')?'：超时':'')));return;}try{const raw=await fs.readFile(headers,'utf8');const blocks=raw.split(/\r?\n\r?\n/).filter(s=>/^HTTP\//.test(s));const final=blocks.at(-1)||'';const status=Number(final.match(/^HTTP\/[^ ]+\s+(\d+)/)?.[1]||0);const contentType=final.match(/^content-type:\s*(.+)$/im)?.[1]?.trim()||'';const location=final.match(/^location:\s*(.+)$/im)?.[1]?.trim();finish(null,{url:url.href,status,contentType,location,text:Buffer.concat(chunks).toString('utf8'),fetchedAt:new Date().toISOString()});}catch(e){finish(e);}});});}finally{await fs.rm(dir,{recursive:true,force:true});}
}

export async function publicFetch(value,{signal,maxBytes=3*1024*1024,redirects=4}={}){
 const {url,addresses}=await validatePublicUrl(value);
 if(signal?.aborted)throw new Error('任务已取消');
 const proxy=await systemProxy();if(proxy){const page=await curlPinned(url,addresses,proxy,{signal,maxBytes});if([301,302,303,307,308].includes(page.status)){if(redirects<=0)throw new Error('重定向过多');if(!page.location)throw new Error('重定向缺少位置');return publicFetch(new URL(page.location,url).href,{signal,maxBytes,redirects:redirects-1});}return page;}
 return await new Promise((resolve,reject)=>{
  const client=url.protocol==='https:'?https:http;let settled=false;let timer;
  const end=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};
  const req=client.request(url,{method:'GET',headers:{'User-Agent':'Mozilla/5.0 (compatible; OfficeAgentLab/1.0; evidence research)','Accept':'text/html,application/json;q=0.9,text/plain;q=0.8','Accept-Encoding':'identity'},lookup:(host,options,cb)=>{const selected=addresses.find(a=>!options.family||a.family===options.family)||addresses[0]; if(options.all)cb(null,[selected]);else cb(null,selected.address,selected.family);}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){
    res.resume();if(redirects<=0){end(new Error('重定向过多'));return;}let next;try{next=new URL(res.headers.location,url).href;}catch{end(new Error('重定向URL无效'));return;}
    publicFetch(next,{signal,maxBytes,redirects:redirects-1}).then(v=>end(null,v),end);return;
   }
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){req.destroy();end(new Error('网页超过3MB抓取上限'));}else chunks.push(chunk);});
   res.on('end',()=>{try{let body=Buffer.concat(chunks);const enc=res.headers['content-encoding'];if(enc==='gzip')body=zlib.gunzipSync(body,{maxOutputLength:maxBytes});else if(enc==='br')body=zlib.brotliDecompressSync(body,{maxOutputLength:maxBytes});else if(enc==='deflate')body=zlib.inflateSync(body,{maxOutputLength:maxBytes});end(null,{url:url.href,status:res.statusCode,contentType:String(res.headers['content-type']||''),text:body.toString('utf8'),fetchedAt:new Date().toISOString()});}catch(e){end(e);}});res.on('error',end);
  });
  const abort=()=>{req.destroy();end(new Error('任务已取消'));};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{req.destroy();end(new Error('公开网页抓取超时（20秒）'));},20000);req.on('error',end);req.end();
 });
}
export function reportHtml(markdown){
 const lines=String(markdown).split(/\r?\n/),out=[];let paragraph=[],list=null;
 const linkUrl=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}};
 const inline=(value,depth=0)=>{
  const source=String(value),tokens=/(`+)([^\n]+?)\1|\*\*([^\n]+?)\*\*|(?<!!)\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<>()\[\]，。；！？、]+)/g;let html='',end=0;
  for(const match of source.matchAll(tokens)){
   html+=escape(source.slice(end,match.index));
   if(match[1])html+='<code>'+escape(match[2])+'</code>';
   else if(match[3])html+='<strong>'+(depth<2?inline(match[3],depth+1):escape(match[3]))+'</strong>';
   else{const raw=match[5]||match[6],suffix=match[6]?.match(/[.,;]+$/)?.[0]||'',url=linkUrl(suffix?raw.slice(0,-suffix.length):raw);html+=url?'<a href="'+escape(url)+'" target="_blank" rel="noopener noreferrer">'+escape(match[4]||raw.slice(0,raw.length-suffix.length))+'</a>'+escape(suffix):escape(match[0]);}
   end=match.index+match[0].length;
  }
  return html+escape(source.slice(end));
 };
 const flushParagraph=()=>{if(paragraph.length){out.push('<p>'+paragraph.map(line=>inline(line)).join('<br>')+'</p>');paragraph=[];}};
 const closeList=()=>{if(list){out.push('</'+list+'>');list=null;}};
 const flush=()=>{flushParagraph();closeList();};
 const cells=value=>{
  let row=value.trim();if(row.startsWith('|'))row=row.slice(1);if(row.endsWith('|')&&!row.endsWith('\\|'))row=row.slice(0,-1);
  const result=[];let cell='',fence=0;
  for(let at=0;at<row.length;at++){
   if(row[at]==='\\'&&row[at+1]==='|'){cell+='|';at++;continue;}
   if(row[at]==='`'){let end=at+1;while(row[end]==='`')end++;const size=end-at;fence=fence===size?0:fence||size;cell+=row.slice(at,end);at=end-1;continue;}
   if(row[at]==='|'&&!fence){result.push(cell.trim());cell='';}else cell+=row[at];
  }
  result.push(cell.trim());return result;
 };
 for(let i=0;i<lines.length;i++){
  const line=lines[i],fence=line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
  if(fence){
   flush();const code=[],character=fence[1][0],size=fence[1].length;const closing=new RegExp('^ {0,3}'+character+'{'+size+',}\\s*$');
   for(i++;i<lines.length&&!closing.test(lines[i]);i++)code.push(lines[i]);
   out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue;
  }
  const heading=line.match(/^ {0,3}(#{1,4})\s+(.+)$/);
  if(heading){flush();const level=Math.max(2,heading[1].length);out.push('<h'+level+'>'+inline(heading[2])+'</h'+level+'>');continue;}
  if(line.includes('|')&&i+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
   flush();const headers=cells(line);i++;const rows=[];
   while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim()){i++;rows.push(cells(lines[i]));}
   out.push('<div class="table-wrap" role="region" tabindex="0" aria-label="报告数据表，可横向滚动"><table><thead><tr>'+headers.map(value=>'<th scope="col">'+inline(value)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(value=>'<td>'+inline(value)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
  }
  const item=line.match(/^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.+)$/);
  if(item){flushParagraph();const type=item[2]?'ol':'ul';if(list!==type){closeList();out.push(type==='ol'&&Number(item[2])!==1?'<ol start="'+Number(item[2])+'">':'<'+type+'>');list=type;}out.push('<li'+(type==='ol'?' value="'+Number(item[2])+'"':'')+'>'+inline(item[3])+'</li>');continue;}
  if(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)){flush();out.push('<hr>');continue;}
  if(/^ {0,3}>\s?/.test(line)){
   flush();const quote=[];while(i<lines.length&&/^ {0,3}>\s?/.test(lines[i])){quote.push(lines[i].replace(/^ {0,3}>\s?/,''));i++;}i--;
   out.push('<blockquote><p>'+quote.map(value=>inline(value)).join('<br>')+'</p></blockquote>');continue;
  }
  if(!line.trim()){flush();continue;}closeList();paragraph.push(line);
 }
 flush();return out.join('\n');
}

function sourceText(value){if(value==null)return '';if(typeof value==='string')return value;if(value.text!=null)return String(value.text);if(value.base64){const b=Buffer.from(value.base64,'base64');if(/\.xlsx$/i.test(value.name||''))return '[用户上传XLSX二进制文件，使用专用导入工具读取]';return b.toString('utf8');}return JSON.stringify(value,null,2);}
function numberedRequirementClauses(raw){
 const markers=[...raw.matchAll(/\b(R\d+)\s*[:：]/g)];
 if(new Set(markers.map(match=>match[1])).size<2)return null;
 const clauses=new Map(),shared=[];
 for(let i=0;i<markers.length;i++){
  const marker=markers[i],end=markers[i+1]?.index??raw.length,contentStart=marker.index+marker[0].length;
  const body=raw.slice(contentStart,end);
  // A common handover note is not evidence for the final business requirement.
  // It can still be extracted separately under an additional requirement ID.
  const footer=[...body.matchAll(/[。；;.!?\r\n][ \t]*(?:#{1,6}[ \t]+)?(?:共同(?:交付)?(?:说明|要求)|统一(?:交付)?(?:说明|要求)|通用(?:交付)?(?:说明|要求)|交付(?:说明|要求|清单)|补充说明|后续说明|交付(?=\s*(?:[A-Za-z]|数据|文件|报告|成果|产物|清单))|拆成|拆分成|需求拆为)/g)].find(match=>body.slice(0,match.index).trim());
  const clauseEnd=footer?contentStart+footer.index+(footer[0].match(/^[。；;.!?\r\n]/)?1:0):end;
  const text=raw.slice(marker.index,clauseEnd).trim();
  if(!clauses.has(marker[1]))clauses.set(marker[1],[]);clauses.get(marker[1]).push(text);
  if(footer)shared.push(raw.slice(clauseEnd,end).trim());
 }
 return {clauses,shared};
}
function unique(arr){return [...new Set(arr)];}
function sanitizeName(name){return String(name||'report').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,70)||'report';}
function parsePriceNumber(raw){const x=String(raw).replace(/[,\s]/g,'');return /^\d+(?:\.\d{1,2})?$/.test(x)&&Number(x)>0?Number(x):null;}
function quoteExtract(page){
 const title=plain(page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'未提取产品标题').slice(0,300);const text=plain(page.text);const prices=[];const products=[];
 for(const match of page.text.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const parsed=JSON.parse(decode(match[1])); const walk=(x,parent)=>{if(Array.isArray(x)){x.forEach(v=>walk(v,parent));return;}if(!x||typeof x!=='object')return;const typ=[x['@type']].flat().map(String);const product=typ.includes('Product')?x:parent;if(typ.includes('Product'))products.push(x);if((typ.includes('Offer')||typ.includes('AggregateOffer')||parent?.offers===x)&&product){const n=parsePriceNumber(x.price??x.lowPrice);if(n&&/^[A-Z]{3}$/.test(x.priceCurrency||''))prices.push({amount:n,currency:x.priceCurrency,kind:x.price!=null?'offer':'starting_price',product:String(product.name||title),evidence:JSON.stringify(x).slice(0,1800),method:'JSON-LD Product offer',availability:x.availability||'未披露',url:x.url||page.url});}for(const [k,v] of Object.entries(x))if(k!=='@context')walk(v,product);};walk(parsed,null);}catch{}
 }
 // Visible currency matches are evidence candidates, never silently treated as equivalent configured systems.
 const re=/(?:US\$|USD\s*\$?|CNY\s*[¥￥]?|RMB\s*[¥￥]?|HK\$|EUR\s*€?|GBP\s*£?|[¥￥$€£])\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
 for(const m of text.matchAll(re)){const n=parsePriceNumber(m[1]);if(!n)continue;const raw=m[0];let currency=raw.startsWith('HK$')?'HKD':/CNY|RMB|¥|￥/.test(raw)?'CNY':/EUR|€/.test(raw)?'EUR':/GBP|£/.test(raw)?'GBP':/US\$|USD/.test(raw)?'USD':'UNKNOWN';const start=Math.max(0,m.index-120);prices.push({amount:n,currency,kind:'visible_price_candidate',product:title,evidence:text.slice(start,m.index+m[0].length+180),method:'可见正文货币片段',availability:'未核实'});if(prices.length>=30)break;}
 const normalized=[];for(const p of prices)if(!normalized.some(q=>q.amount===p.amount&&q.currency===p.currency&&q.product===p.product))normalized.push(p);
 const chosen=normalized.filter(p=>p.method==='JSON-LD Product offer');const single=chosen.length===1?chosen[0]:normalized.length===1&&normalized[0].currency!=='UNKNOWN'?normalized[0]:null;
 const selectedConfiguration=[];for(const tag of page.text.matchAll(/<input\b[^>]*>/gi)){if(/\bchecked(?:\s|=|>)/i.test(tag[0])){const m=tag[0].match(/aria-label=["']([\s\S]*?)["']/i);if(m)selectedConfiguration.push(decode(m[1]));}}
 const config=[];const configRe=/(?:\b\d{1,4}\s*(?:GB|TB|MHz|GHz)\b|(?:Intel|AMD|Xeon|EPYC|Ryzen|Core\s+i\d|DDR[345]|PowerEdge|ThinkSystem|ProLiant)[^.;。]{0,100}|\b(?:SSD|HDD|NVMe|RAID|warranty|保修|质保)[^.;。]{0,80})/gi;
 for(const m of text.matchAll(configRe)){config.push(m[0]);if(config.length>=35)break;}
 const lowerTitle=title.toLowerCase();let productType=/\b(?:ec2|virtual|cloud|vps)\b|云服务器|云主机/.test(lowerTitle)?'cloud_service':/\b(?:hard drive|memory module|network adapter|power supply|rack rail)\b|内存条|硬盘配件/.test(lowerTitle)?'component':/server|poweredge|thinksystem|proliant|服务器/i.test(title)?'server_hardware':'unverified';
 return {title,productType,status:single?'priced':normalized.length?'multiple_price_candidates':'pending_inquiry',price:single?.amount??null,currency:single?.currency??null,priceKind:single&&text.includes('Starting at')?'starting_price':single?.kind??null,priceCandidates:normalized,selectedConfiguration:unique(selectedConfiguration),configurationEvidence:unique(config),tax:'未核实',shipping:'未核实',warranty:'请核对配置证据；未获确认',availability:single?.availability||'未核实',sourceExcerpt:text.slice(0,30000),limitation:normalized.length>1?'同页存在多种报价，不能直接视作单一整机成交价':!normalized.length?'未提取到带币种的公开标价，需要询价或人工核对':'公开展示价，配置和税费仍需核实'};
}

export async function createToolbox({runDir,input={},emit=()=>{},signal,approval=async()=>({approved:false,note:'未提供审批'})}){
 const base=path.resolve(runDir);await fs.mkdir(base,{recursive:true});const registry=new Map();const outputs={};let serial=0;let deliveryPlan=null;let requirementDoc=null;let quoteCounter=0;const quotes=[];
 const safe=(name)=>{const p=path.resolve(base,name);if(!p.startsWith(base+path.sep))throw new Error('文件路径越出任务工作区');return p;};
 const put=async(name,content)=>{const p=safe(name);await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.tmp-'+crypto.randomBytes(4).toString('hex');await fs.writeFile(tmp,typeof content==='string'||Buffer.isBuffer(content)?content:JSON.stringify(content,null,2));await fs.rename(tmp,p);return name;};
 const register=async(name)=>{const p=safe(name);const st=await fs.stat(p);if(!st.isFile())throw new Error('产物不是文件');const id=crypto.createHash('sha256').update(name).digest('hex').slice(0,18);const item={id,name:path.basename(name),mimeType:mime[path.extname(name)]||'application/octet-stream',path:name,bytes:st.size};registry.set(name,item);emit({type:'artifact',text:'生成文件：'+item.name,artifact:item});return item;};
 const python=async(operation,args)=>new Promise((resolve,reject)=>{const child=spawn(PYTHON,[path.join(projectDir,'tools/office_tools.py')],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});let stdout='',stderr='';let done=false;const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('数据工具执行超过45秒'));},45000);const abort=()=>{child.kill('SIGKILL');finish(new Error('任务已取消'));};signal?.addEventListener('abort',abort,{once:true});const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};child.on('error',e=>finish(new Error('Python工具启动失败: '+e.message)));child.stdout.on('data',c=>{stdout+=c.toString();if(stdout.length>6*1024*1024){child.kill();finish(new Error('工具输出超过安全上限'));}});child.stderr.on('data',c=>{stderr=(stderr+c.toString()).slice(-2000);});child.on('close',code=>{if(done)return;try{const value=JSON.parse(stdout);if(!value.ok)finish(new Error(value.error));else finish(null,value.result);}catch{finish(new Error('工具返回无效结果（退出码'+code+'）'+(stderr?': '+stderr:'')));}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({runDir:base,input,args,operation}));});
 const rawRequirements=()=>[String(input.requirements||''),sourceText(input.data)].filter(Boolean).join('\n\n');
 const functions={
  ...createInvestmentFunctions({input,put,outputs,approval,publicFetch:url=>publicFetch(url,{signal}),validatePublicUrl}),
  ...createOnboardingFunctions({input,runDir:base,put,outputs,approval,signal}),
  ...Object.fromEntries(['import_finance','calculate_finance','audit_finance','design_database','build_database','test_database','inspect_network','analyze_traffic','verify_network'].map(name=>[name,args=>python(name,args)])),
  async search_web(args){
   const query=String(args.query||input.query||input.requirements||'').trim().slice(0,400);if(!query)throw new Error('检索词不能为空');const limit=Math.min(8,Math.max(1,Math.trunc(args.limit||8)));const candidates=[];const attempts=[];let raw='';
   const userUrls=Array.isArray(input.urls)?input.urls:String(input.urls||'').split(/[\r\n]+/);for(const url of userUrls.filter(Boolean).slice(0,8)){await validatePublicUrl(url);candidates.push({url:new URL(url).href,title:'用户指定候选供应商',source:'user'});}
   for(const endpoint of ['https://www.bing.com/search?q='+encodeURIComponent(query)+'&cc=us&setlang=en-us&ensearch=1','https://html.duckduckgo.com/html/?q='+encodeURIComponent(query)]){
    try{const page=await publicFetch(endpoint,{signal});raw=page.text;attempts.push({url:page.url,status:page.status,fetchedAt:page.fetchedAt});if(page.status<200||page.status>=300)continue;
     const blocks=[...raw.matchAll(/<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m=>m[1]);
     if(!blocks.length)blocks.push(...[...raw.matchAll(/<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)].map(m=>m[0]));
     for(const block of blocks){const m=block.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);if(!m)continue;let u;try{u=new URL(decode(m[1]),page.url);if(u.searchParams.has('uddg'))u=new URL(u.searchParams.get('uddg'));if(u.hostname.endsWith('bing.com')&&u.pathname==='/ck/a'){const encoded=u.searchParams.get('u');if(encoded?.startsWith('a1'))u=new URL(Buffer.from(encoded.slice(2),'base64url').toString('utf8'));}if(!['http:','https:'].includes(u.protocol)||/bing\.com$|duckduckgo\.com$/.test(u.hostname))continue;}catch{continue;}if(!candidates.some(c=>c.url===u.href))candidates.push({url:u.href,title:plain(m[2]).slice(0,250),source:'live_search'});}
     if(candidates.some(c=>c.source==='live_search'))break;
    }catch(e){attempts.push({url:endpoint,error:e.message,fetchedAt:new Date().toISOString()});}
   }
   const doc={query,scope:'本次实际检索和用户候选范围，不代表穷尽全互联网',attempts,candidates:candidates.slice(0,limit),searchAvailable:attempts.some(a=>a.status>=200&&a.status<300),retrievedAt:new Date().toISOString()};await put('procurement/search.json',doc);await put('procurement/search-evidence.html',raw||'未收到搜索网页正文');return {summary:doc.candidates.length?'获取'+doc.candidates.length+'个供应商候选；须逐个抓取核实报价':'搜索未取得可用候选，需用户补充公开供应商链接',evidence:doc,files:['procurement/search.json','procurement/search-evidence.html']};
  },
  async fetch_quote(args){
   let urls=Array.isArray(args.urls)?args.urls:args.url?[args.url]:[];if(!urls.length)throw new Error('必须提供真实候选URL');if(urls.length>8)throw new Error('单次最多抓取8个报价URL');const list=[];const files=[];
   for(const value of unique(urls.map(String))){
    await validatePublicUrl(value);const existing=quotes.find(q=>q.requestedUrl===new URL(value).href);if(existing){list.push(existing);continue;}
    const id='Q'+(++quoteCounter);const stem='procurement/'+id;let quote={id,requestedUrl:new URL(value).href,sourceUrl:new URL(value).href,fetchedAt:new Date().toISOString(),status:'pending_inquiry'};
    try{const page=await publicFetch(value,{signal});if(!/text\/html|application\/(?:ld\+)?json|text\/plain/i.test(page.contentType)){quote={...quote,httpStatus:page.status,reason:'非可解析HTML/JSON网页，需人工询价'};}else{await put(stem+'-source.html',page.text);files.push(stem+'-source.html');quote={...quote,sourceUrl:page.url,fetchedAt:page.fetchedAt,httpStatus:page.status,...quoteExtract(page)};if(page.status<200||page.status>=300){quote.status='pending_inquiry';quote.price=null;quote.currency=null;quote.reason='HTTP '+page.status+'，不采用错误页标价';}}
    }catch(e){quote.reason=e.message;}
    quotes.push(quote);list.push(quote);await put(stem+'-evidence.json',quote);files.push(stem+'-evidence.json');
   }
   await put('procurement/quotes.json',quotes);files.push('procurement/quotes.json');return {summary:'实时抓取'+list.length+'个候选；'+list.filter(q=>q.status==='priced').length+'个提取到单一公开标价，其余保留价格候选/待询价',evidence:{quotes:list,scope:'仅本次实际获取的候选网页，价格和库存以供应商确认时为准'},files};
  },
  async compare_quotes(args){
   if(!quotes.length)throw new Error('没有已抓取报价；请先fetch_quote');const currency=String(input.currency||'CNY');const budget=Number(input.budget);const requested=String(input.requirements||'');const memReq=requested.match(/(\d+(?:\.\d+)?)\s*GB\s*(?:内存|RAM|memory)/i);const ssdReq=requested.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:SSD|NVMe|固态)/i);const minMem=memReq?Number(memReq[1]):null;const minSsd=ssdReq?Number(ssdReq[1])*(ssdReq[2].toUpperCase()==='TB'?1024:1):null;const checkConfiguration=q=>{const selected=q.selectedConfiguration||[];const memories=selected.filter(t=>/DIMM|RAM|memory|内存/i.test(t)).flatMap(t=>[...t.matchAll(/(\d+)\s*GB/ig)].map(m=>Number(m[1])));const disks=selected.filter(t=>/SSD|NVMe|solid state|固态/i.test(t)&&/\d\s*(?:GB|TB)/i.test(t)).map(t=>{const m=t.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i);return Number(m[1])*(m[2].toUpperCase()==='TB'?1024:1);});const checks={memoryMinimumGb:minMem,selectedMemoryModuleGb:memories.length?Math.max(...memories):null,memoryMeetsMinimum:minMem==null?null:memories.length?Math.max(...memories)>=minMem:null,ssdMinimumGb:minSsd,selectedSsdCapacityGb:disks.length?Math.max(...disks):null,ssdMeetsMinimum:minSsd==null?null:disks.length?Math.max(...disks)>=minSsd:selected.some(t=>/Hard Drive|HDD|硬盘/i.test(t))?false:null};return checks;};const purpose=String(args.purpose||'综合审查').slice(0,100);const rows=quotes.map(q=>{const technicalChecks=checkConfiguration(q);const comparable=q.status==='priced'&&q.productType==='server_hardware'&&q.currency===currency&&technicalChecks.memoryMeetsMinimum===true&&technicalChecks.ssdMeetsMinimum===true;return ({id:q.id,title:q.title||'抓取未成功',sourceUrl:q.sourceUrl,fetchedAt:q.fetchedAt,status:q.status,productType:q.productType||'unverified',price:q.price??null,currency:q.currency??null,selectedConfiguration:q.selectedConfiguration||[],technicalChecks,configurationEvidence:q.configurationEvidence||[],tax:q.tax||'未知',shipping:q.shipping||'未知',warranty:q.warranty||'未知',sameBudgetCurrency:q.currency===currency,listedPriceWithinBudget:q.price!=null&&q.currency===currency&&Number.isFinite(budget)?q.price<=budget:null,comparable,comparisonReason:q.status!=='priced'?'未获取唯一确认标价':q.productType!=='server_hardware'?'非整机或类型尚未确认':technicalChecks.memoryMeetsMinimum===false||technicalChecks.ssdMeetsMinimum===false?'页面已选配置不满足已识别的最低内存/SSD要求':comparable?'公开已选配置符合可自动核对的内存/SSD下限；仍需审查CPU、税费和服务':'缺乏足够已选配置证据，不能认定等价',reason:q.reason||q.limitation});});
   const doc={purpose,budget:Number.isFinite(budget)?budget:null,budgetCurrency:currency,requirements:String(input.requirements||''),quotes:rows,notes:String(args.notes||''),comparableQuoteCount:rows.filter(r=>r.comparable).length,technicalCheckScope:'仅自动核对用户原文可明确解析的GB内存及SSD容量，以及供应商页面实际勾选配置；CPU、兼容性和服务条件须结合Agent审查，不代表完整验收。',limitations:['标价是抓取时公开网页证据，不是供应商书面最终报价。','同页多价、未披露配置或币种不明时不参与价格排名。','未取得税费/运输/保修完整信息，不宣称最终采购总成本在预算内。','仅比较已抓取候选；硬件、配件和云服务分开，不作汇率换算。'],purchaseExecuted:false};const safePurpose=sanitizeName(purpose);const file='procurement/comparison-'+safePurpose+'-'+(++serial)+'.json';await put(file,doc);const csv=file.replace(/\.json$/,'.csv');await put(csv,'\ufeff'+[['ID','产品','类别','状态','标价','币种','可比','来源','抓取时间','限制'],...rows.map(r=>[r.id,r.title,r.productType,r.status,r.price??'',r.currency??'',r.comparable?'容量条件初核符合':'否/待核实',r.sourceUrl,r.fetchedAt,r.comparisonReason])].map(row=>row.map(csvCell).join(',')).join('\r\n'));return {summary:'已核对'+rows.length+'个真实候选，配置等价与总成本未知项保留，未执行采购',evidence:doc,files:[file,csv]};
  },
  async apply_defense(args){
   const analysisPath=safe('network/analysis.json');let analysis;try{analysis=JSON.parse(await fs.readFile(analysisPath,'utf8'));}catch{throw new Error('先完成日志检查与流量分析');}
   const blockedIps=unique((args.blockedIps||[]).map(String));if(blockedIps.some(ip=>!net.isIP(ip)))throw new Error('封禁名单包含无效IP');const evidenceIps=new Set(analysis.sources.map(s=>s.ip));if(blockedIps.some(ip=>!evidenceIps.has(ip)))throw new Error('不能封禁未出现在本次证据中的IP');
   const rateLimit=args.rateLimit==null?null:Number(args.rateLimit);const windowSeconds=Number(args.windowSeconds||analysis.windowSeconds||60);if(rateLimit!==null&&(!Number.isInteger(rateLimit)||rateLimit<1||rateLimit>100000))throw new Error('速率阈值须为1至100000整数');if(!Number.isInteger(windowSeconds)||windowSeconds<1||windowSeconds>3600)throw new Error('时间窗无效');if(!blockedIps.length&&rateLimit===null)throw new Error('请提供基于证据的IP或速率策略');const reason=String(args.reason||'').trim();if(!reason)throw new Error('防护方案必须说明证据与误伤风险');
   const proposal={blockedIps,rateLimit,windowSeconds,reason,environment:'仅本次run隔离副本，不修改主机或生产网络',createdAt:new Date().toISOString()};await put('network/proposal.json',proposal);await register('network/proposal.json');
   const decision=await approval({title:'批准隔离防护方案',description:'确认后仅在本次隔离日志副本应用策略，生成配置并交给独立Agent重放验证。',details:proposal});
   const defense={...proposal,approved:!!decision?.approved,approvalNote:String(decision?.note||''),approvedAt:new Date().toISOString()};await put('network/defense.json',defense);const files=['network/defense.json'];
   if(defense.approved){const lines=['# 隔离策略交付片段；未安装或修改任何生产服务','# 需生产评审后才可人工部署，速率算法与离线滑动窗并不完全相同',...blockedIps.map(ip=>'deny '+ip+';')];if(rateLimit!==null){lines.push('# http上下文：','limit_req_zone $binary_remote_addr zone=office_rescue:10m rate='+Math.max(1,Math.round(rateLimit/windowSeconds*60))+'r/m;','# server/location上下文：','limit_req zone=office_rescue burst='+Math.max(1,rateLimit)+' nodelay;');}await put('network/nginx-defense.conf',lines.join('\n')+'\n');files.push('network/nginx-defense.conf');}
   return {summary:defense.approved?'真人已批准，隔离策略文件已应用到本次重放配置':'真人拒绝本次方案，未应用防护；保留提案交独立验证',evidence:defense,files};
  },
  async extract_requirements(args){
   const raw=rawRequirements();if(!raw.trim())throw new Error('用户需求不能为空');const proposed=args.requirements;
   if(!Array.isArray(proposed)||!proposed.length)throw new Error('请根据原始需求提交requirements数组，包含id、description、source原文与acceptance，不能仅复制任务名称');
   const numbered=numberedRequirementClauses(raw),proposedIds=new Set(proposed.map((r,i)=>String(r.id||'R'+(i+1))));
   if(numbered){const missing=[...numbered.clauses.keys()].filter(id=>!proposedIds.has(id));if(missing.length)throw new Error('原始需求包含明确编号，提取结果缺少需求ID：'+missing.join('、')+'。请保留原编号，逐项补全后重新提交。');}
   const seen=new Set();const rows=proposed.map((r,i)=>{const id=String(r.id||'R'+(i+1));if(seen.has(id))throw new Error('重复需求ID: '+id);seen.add(id);const source=String(r.source||'').trim();if(!source||!raw.includes(source))throw new Error('需求'+id+'的source必须逐字引用用户原文，不能伪造来源');if(numbered){const clauses=numbered.clauses.get(id);if(clauses&&!clauses.some(text=>text.includes(source)))throw new Error('需求'+id+'的source必须逐字引用原文'+id+'对应的业务条款，不能引用公司背景、其他编号或共同交付说明。');if(!clauses&&!numbered.shared.some(text=>text.includes(source)))throw new Error('需求'+id+'不是原文编号；额外需求的source须来自明确的共同交付说明，不能重新编号已有业务条款。');}if(!String(r.description||'').trim()||!String(r.acceptance||'').trim())throw new Error('每个需求须有描述和可核验验收条件');return {id,description:String(r.description),source,acceptance:String(r.acceptance),confirmedByCustomer:false};});
   requirementDoc={project:String(input.company||'本次业务需求'),source:raw,requirements:rows,entities:args.entities||[],questions:args.questions||[],exclusions:args.exclusions||[],assumptions:args.assumptions||[],createdAt:new Date().toISOString()};await put('delivery/requirements.json',requirementDoc);await put('delivery/requirements.md','# '+requirementDoc.project+' 需求规格\n\n'+rows.map(r=>'## '+r.id+' '+r.description+'\n\n来源：'+r.source+'\n\n验收：'+r.acceptance).join('\n\n')+'\n\n## 待确认\n\n'+requirementDoc.questions.map(x=>'- '+x).join('\n')+'\n\n## 假设\n\n'+requirementDoc.assumptions.map(x=>'- '+x).join('\n'));return {summary:'从用户原文提取'+rows.length+'项有来源的需求和验收条件','evidence':requirementDoc,files:['delivery/requirements.json','delivery/requirements.md']};
  },
  async estimate_delivery(args){
   if(!requirementDoc){try{requirementDoc=JSON.parse(await fs.readFile(safe('delivery/requirements.json'),'utf8'));}catch{throw new Error('请先提取需求');}}
   const old=deliveryPlan;const packages=args.packages||old?.packages;if(!Array.isArray(packages)||!packages.length)throw new Error('首次估算须提交packages具体工作包（id/name/days/dependsOn/requirementIds/deliverable）');if(old&&args.packages&&JSON.stringify(args.packages)!==JSON.stringify(old.packages.map(({startDay,endDay,cost,...p})=>p)))throw new Error('工作包已由业务Agent保存，财务复核应省略packages复用底稿；需要变更请重新发起任务');
   const dailyRate=Number(args.dailyRate??input.dailyRate??1500);if(input.dailyRate!=null&&args.dailyRate!=null&&Number(args.dailyRate)!==Number(input.dailyRate))throw new Error('不能改写用户指定人日单价，请使用输入单价');const teamSize=Number(args.teamSize??old?.teamSize??1);const bufferPct=Number(args.bufferPct??old?.bufferPct??0);if(!Number.isFinite(dailyRate)||dailyRate<=0||dailyRate>1000000||!Number.isInteger(teamSize)||teamSize<1||teamSize>50||!Number.isFinite(bufferPct)||bufferPct<0||bufferPct>100)throw new Error('人日单价、人数或缓冲比例无效');
   const ids=new Set();const reqs=new Set(requirementDoc.requirements.map(r=>r.id));const normalized=packages.map(p=>{const id=String(p.id||'');const days=Number(p.days);if(!id||ids.has(id)||!String(p.name||'').trim()||!String(p.deliverable||'').trim()||!Number.isFinite(days)||days<=0||days>1000)throw new Error('工作包需唯一ID、名称、有效人日与产物');ids.add(id);const rr=p.requirementIds||[];if(rr.some(r=>!reqs.has(r)))throw new Error('工作包引用不存在的需求ID');return {id,name:String(p.name),days,dependsOn:unique(p.dependsOn||[]),requirementIds:rr,deliverable:String(p.deliverable)};});
   for(const p of normalized)if(p.dependsOn.some(d=>!ids.has(d)||d===p.id))throw new Error('存在缺失或自引用的依赖');const computed=new Map();const visiting=new Set();let cursor=0;
   const schedule=p=>{if(computed.has(p.id))return computed.get(p.id);if(visiting.has(p.id))throw new Error('工作包依赖存在循环');visiting.add(p.id);const dependencyEnd=Math.max(0,...p.dependsOn.map(id=>schedule(normalized.find(x=>x.id===id)).endDay));const startDay=Math.max(cursor,dependencyEnd);const endDay=Math.round((startDay+p.days/teamSize)*10000)/10000;cursor=endDay;const row={...p,startDay,endDay,cost:Math.round(p.days*dailyRate*100)/100};computed.set(p.id,row);visiting.delete(p.id);return row;};normalized.forEach(schedule);const resultRows=normalized.map(p=>computed.get(p.id));const personDays=Math.round(normalized.reduce((n,p)=>n+p.days,0)*10000)/10000;const subtotal=resultRows.reduce((n,p)=>n+Math.round(p.cost*100),0)/100;const contingency=Math.round(subtotal*bufferPct)/100;
   const budgetMatch=String(input.requirements||'').match(/预算\s*(?:为|约|上限|[:：])?\s*([0-9]+(?:\.[0-9]+)?)\s*(万|千)?\s*(?:元|人民币|CNY)/i);const requestedBudget=budgetMatch?Number(budgetMatch[1])*(budgetMatch[2]==='万'?10000:budgetMatch[2]==='千'?1000:1):null;
   deliveryPlan={project:requirementDoc.project,packages:resultRows,personDays,dailyRate,teamSize,bufferPct,subtotal,contingency,totalCost:Math.round((subtotal+contingency)*100)/100,currency:'CNY',elapsedWorkingDays:Math.max(...resultRows.map(p=>p.endDay)),roundingMethod:'各工作包先按分四舍五入，再求和；缓冲按小计比例取分',schedulingMethod:'保守串行工作包；每工作包使用同一团队，依赖优先；不将人日直接冒充日历天',assumptions:args.assumptions||old?.assumptions||[],notContractQuote:true,requestedBudget,budgetSource:budgetMatch?.[0]||null,budgetDifference:requestedBudget==null?null:Math.round((subtotal+contingency-requestedBudget)*100)/100,requirementsCovered:unique(resultRows.flatMap(p=>p.requirementIds))};await put('delivery/plan.json',deliveryPlan);
   await put('delivery/plan.csv','\ufeff'+[['ID','工作包','人日','开始工作日','结束工作日','依赖','覆盖需求','产物','成本CNY'],...resultRows.map(p=>[p.id,p.name,p.days,p.startDay,p.endDay,p.dependsOn.join(';'),p.requirementIds.join(';'),p.deliverable,p.cost])].map(r=>r.map(csvCell).join(',')).join('\r\n'));return {summary:'确定性计算'+personDays+'人日，估算¥'+deliveryPlan.totalCost+'，'+deliveryPlan.elapsedWorkingDays+'个工作日（'+teamSize+'人）',evidence:deliveryPlan,files:['delivery/plan.json','delivery/plan.csv']};
  },
  async review_delivery(args){
   const req=requirementDoc||await fs.readFile(safe('delivery/requirements.json'),'utf8').then(JSON.parse).catch(()=>null);if(!req)throw new Error('没有已保存的需求底稿');const plan=deliveryPlan||await fs.readFile(safe('delivery/plan.json'),'utf8').then(JSON.parse).catch(()=>null);const missing=plan?req.requirements.filter(r=>!plan.requirementsCovered.includes(r.id)).map(r=>r.id):req.requirements.map(r=>r.id);const issues=[...(args.issues||[])];const checks={sourceQuotesMatch:req.requirements.every(r=>req.source.includes(r.source)),uniqueRequirementIds:new Set(req.requirements.map(r=>r.id)).size===req.requirements.length,planExists:!!plan,coverageComplete:!!plan&&!missing.length,calculationConsistent:plan?Math.abs(plan.totalCost-(plan.packages.reduce((n,p)=>n+p.cost,0)+plan.contingency))<0.011:false,dependencyScheduleValid:plan?plan.packages.every(p=>p.dependsOn.every(id=>p.startDay>=plan.packages.find(x=>x.id===id).endDay)):false};if(!plan)issues.push('尚无工作包计划；数据库需求场景只校验需求来源，不能宣称工期预算已核算');if(missing.length)issues.push('尚未由工作包覆盖的需求: '+missing.join(','));const checklist=req.requirements.map(r=>({id:r.id,acceptance:r.acceptance,coveredBy:plan?.packages.filter(p=>p.requirementIds.includes(r.id)).map(p=>p.id)||[],status:'待交付后验收，非已通过'}));const result={passed:Object.values(checks).every(Boolean)&&!issues.length,checks,missingRequirementIds:missing,issues,risks:args.risks||[],openQuestions:req.questions,assumptions:req.assumptions,checklist,customerApproved:false,notContractQuote:true};const name='delivery/review-'+(++serial)+'.json';await put(name,result);await put('delivery/acceptance-checklist.csv','\ufeff'+[['需求ID','验收条件','覆盖工作包','状态'],...checklist.map(r=>[r.id,r.acceptance,r.coveredBy.join(';'),r.status])].map(r=>r.map(csvCell).join(',')).join('\r\n'));return {summary:'独立审校'+(result.passed?'通过底稿一致性检查':'发现待确认或缺失项')+'；客户验收尚未执行',evidence:result,files:[name,'delivery/acceptance-checklist.csv']};
  },
  async write_report(args){
   const title=String(args.title||'').trim(),content=String(args.content||'').trim();
   if(!title||content.length<100)throw new Error('报告需标题及至少100字符实际正文；不得只写完成或引用文件名');
   const name='reports/'+sanitizeName(title)+'-'+(++serial),leadingHeading=content.match(/^#\s+([^\r\n]+)(?:\r?\n|$)/),includesTitle=leadingHeading?.[1].trim()===title;
   await put(name+'.md',includesTitle?content+'\n':'# '+title+'\n\n'+content+'\n');
   const reportContent=includesTitle?content.slice(leadingHeading[0].length).replace(/^(?:\r?\n)+/,''):content;
   await put(name+'.html',reportDocument({title,body:reportHtml(reportContent)}));
   return {summary:'正式报告已保存：'+title,evidence:{title,characters:content.length,sourceToolResults:Object.keys(outputs),sentExternally:false},files:[name+'.md',name+'.html']};
  },
  async list_artifacts(){return {summary:'本次已有'+registry.size+'个真实文件',evidence:{artifacts:[...registry.values()].map(({path,...x})=>x),toolResults:outputs}};},
 };
 return {definitions:TOOL_DEFINITIONS,async execute(name,args={},role){
  if(signal?.aborted)throw new Error('任务已取消');if(!functions[name])throw new Error('不允许的工具: '+name);const id=typeof role==='string'?role:role?.id;const configured=typeof role==='object'&&Array.isArray(role.tools)?role.tools:null;const allowed=AGENTS.find(a=>a.id===id)?.tools||[];if(!allowed.includes(name)||(configured&&!configured.includes(name)))throw new Error('角色'+String(id)+'没有'+name+'权限');if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('工具参数必须为对象');
  emit({type:'tool',text:'执行 '+name,tool:name});const result=await functions[name](args);const registered=[];for(const file of unique(result.files||[]))registered.push(await register(file));const publicResult={...result,artifacts:registered.map(({path,...r})=>r)};outputs[name]=publicResult.evidence??publicResult;emit({type:'result',text:result.summary||name+'完成',tool:name});return publicResult;
 },artifacts:()=>[...registry.values()],publicState:()=>({toolResults:outputs,quoteCount:quotes.length,artifactCount:registry.size})};
}
