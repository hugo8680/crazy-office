import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../src/join.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/join.html',import.meta.url),'utf8');
const css=await readFile(new URL('../src/join.css',import.meta.url),'utf8');
const TOKEN='t'.repeat(43),PASSWORD='employee-secure-password-2026';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

// Execute the actual form script against small DOM/fetch adapters. The fixture
// controls only responses; validation, retry and double-submit are production JS.
function harness(fragment='#token='+TOKEN){
  const elements=new Map(),requests=[],history=[],timers=new Map();let responder=async()=>({ok:true,status:200,json:async()=>({employee:{id:'employee-1',username:'zhang'}})}),timerSequence=0;
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{value:'',hidden:false,disabled:false,textContent:'',listeners:new Map(),attributes:new Map(),focused:0,addEventListener(type,handler){this.listeners.set(type,handler);},setAttribute(name,value){this.attributes.set(name,value);},focus(){this.focused++;}});return elements.get(selector);};
  const location={hash:fragment,pathname:'/join',search:'?ignored=1',assign(){throw new Error('页面不可自动跳转');}};
  const scope={URLSearchParams,TextEncoder,AbortController,document:{querySelector:element},window:{location,history:{replaceState(state,title,url){history.push(url);location.hash='';location.search='';}}},setTimeout(fn){const id=++timerSequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},fetch:async(url,options)=>{requests.push({url,options});return responder(url,options);},console:{log(){throw new Error('不应记录凭据');},error(){throw new Error('不应记录凭据');}},localStorage:{setItem(){throw new Error('不应保存凭据');}},sessionStorage:{setItem(){throw new Error('不应保存凭据');}}};
  vm.createContext(scope);vm.runInContext(source,scope,{filename:'join.js'});
  return {scope,element,requests,history,timers,eval:code=>vm.runInContext(code,scope),respond(fn){responder=fn;},password(value=PASSWORD,confirm=value){element('#password').value=value;element('#password-confirm').value=confirm;},submit(){return element('#join-form').listeners.get('submit')({preventDefault(){}});}};
}

test('邀请 fragment 立即清理，初始无网络请求或 DOM 凭据',()=>{
  const h=harness();assert.deepEqual(h.history,['/join']);assert.equal(h.scope.window.location.hash,'');assert.equal(h.requests.length,0);
  assert.equal(h.eval('invitationToken'),TOKEN);assert.equal(h.eval('fragment.has("token")'),false);
  for(const selector of ['#join-form','#join-description','#join-error','#join-result-text'])assert.equal(h.element(selector).textContent.includes(TOKEN),false);
  assert.doesNotMatch(html,/<input[^>]+(?:token|hidden)/);assert.match(html,/name="referrer" content="no-referrer"/);
});

test('缺失、格式错误或重复 token 显示失效提示且不能提交',async()=>{
  for(const fragment of ['', '#token=short','#token='+TOKEN+'&token='+TOKEN,'#token='+encodeURIComponent('<script>')]){
    const h=harness(fragment);h.password();await h.submit();assert.equal(h.element('#join-form').hidden,true);assert.equal(h.element('#join-title').textContent,'链接不可用');assert.equal(h.requests.length,0);assert.equal(h.eval('invitationToken'),'');
  }
});

test('两次口令长度、一致性与 UTF-8 字节限制在请求前校验',async()=>{
  const h=harness();
  for(const [password,confirmation,expected] of [['short','short','至少'],[PASSWORD,PASSWORD+'wrong','不一致'],['汉'.repeat(400),'汉'.repeat(400),'过长']]){
    h.password(password,confirmation);await h.submit();assert.match(h.element('#join-error').textContent,new RegExp(expected));assert.equal(h.requests.length,0);
  }
});

test('单次请求提交正确凭据，执行期间禁双击，成功清空内存并让用户自行登录',async()=>{
  const h=harness(),pending=deferred();h.respond(()=>pending.promise);h.password();const first=h.submit();await h.submit();
  assert.equal(h.requests.length,1);assert.equal(h.element('#join-button').disabled,true);assert.equal(h.element('#password').disabled,true);assert.equal(h.element('#join-form').attributes.get('aria-busy'),'true');
  const request=h.requests[0];assert.equal(request.url,'/api/erp/invitations/accept');assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.referrerPolicy,'no-referrer');assert.equal(request.options.cache,'no-store');assert.deepEqual(JSON.parse(request.options.body),{token:TOKEN,password:PASSWORD});
  pending.resolve({ok:true,status:200,json:async()=>({employee:{id:'employee-1',username:'zhang'}})});await first;
  assert.equal(h.element('#join-form').hidden,true);assert.equal(h.element('#join-title').textContent,'密码已设置');assert.equal(h.element('#join-result').hidden,false);assert.match(h.element('#join-result-text').textContent,/zhang/);assert.equal(h.element('#password').value,'');assert.equal(h.element('#password-confirm').value,'');assert.equal(h.eval('invitationToken'),'');assert.equal(h.timers.size,0);
  await h.submit();assert.equal(h.requests.length,1);
});

test('校验错误保留邀请但清空口令，解锁重试后可成功',async()=>{
  const h=harness();h.respond(async()=>({ok:false,status:400,json:async()=>({error:'密码需至少12个字符。'})}));h.password();await h.submit();
  assert.equal(h.element('#join-error').textContent,'密码需至少12个字符。');assert.equal(h.element('#password').value,'');assert.equal(h.element('#join-button').disabled,false);assert.equal(h.eval('invitationToken'),TOKEN);
  h.respond(async()=>({ok:true,status:200,json:async()=>({employee:{id:'employee-1',username:'zhang'}})}));h.password();await h.submit();assert.equal(h.requests.length,2);assert.equal(h.element('#join-title').textContent,'密码已设置');
});

test('过期或已用链接不再可重试，页面不会回显服务端中的口令或 token',async()=>{
  const expired=harness();expired.respond(async()=>({ok:false,status:410,json:async()=>({error:'邀请无效或已过期。'})}));expired.password();await expired.submit();assert.equal(expired.element('#join-form').hidden,true);assert.equal(expired.eval('invitationToken'),'');
  for(const message of ['诊断 '+TOKEN,'诊断 '+PASSWORD]){
    const h=harness();h.respond(async()=>({ok:false,status:400,json:async()=>({error:message})}));h.password();await h.submit();assert.equal(h.element('#join-error').textContent,'密码未设置，请重试。');assert.equal(h.element('#join-error').textContent.includes(TOKEN),false);assert.equal(h.element('#join-error').textContent.includes(PASSWORD),false);
  }
});

test('服务端错误和中断可重试；不完整成功响应不能伪装设置完成',async()=>{
  const h=harness();
  for(const respond of [async()=>({ok:false,status:503,json:async()=>({error:'内部堆栈'})}),async()=>{throw new Error('断线');},async()=>({ok:true,status:200,json:async()=>({})})]){
    h.respond(respond);h.password();await h.submit();assert.equal(h.element('#join-form').hidden,false);assert.equal(h.eval('finished'),false);assert.equal(h.eval('invitationToken'),TOKEN);assert.equal(h.element('#join-button').disabled,false);assert.equal(h.element('#password-confirm').value,'');
  }
});

test('请求超时触发取消，保留可重试状态而不后台重复提交',async()=>{
  const h=harness();h.respond(async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')))));h.password();const pending=h.submit();assert.equal(h.timers.size,1);[...h.timers.values()][0]();await pending;
  assert.equal(h.requests.length,1);assert.equal(h.element('#join-button').disabled,false);assert.match(h.element('#join-error').textContent,/连接中断/);assert.equal(h.timers.size,0);
});

test('重设和入驻共用明确文案，页面包含可访问表单且没有 shadow 或单侧装饰边框',()=>{
  assert.match(html,/<h1 id="join-title">设置登录密码/);assert.match(html,/href="\/login"/);assert.match(html,/autocomplete="new-password"/);assert.match(html,/role="alert"/);assert.match(html,/aria-live="polite"/);
  assert.doesNotMatch(css,/(?:box-shadow|text-shadow|filter\s*:|border-(?:left|right|top|bottom)\s*:)/);
  assert.doesNotMatch(source,/(?:localStorage|sessionStorage|console\.|innerHTML|location\.assign)/);
});
