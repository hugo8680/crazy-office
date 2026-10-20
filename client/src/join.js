// Invitation secrets stay in this script's lexical memory. They are removed
// from the address before any request and are never written to storage or DOM.
const fragment=new URLSearchParams(window.location.hash.slice(1));
let invitationToken=fragment.getAll('token').length===1?fragment.get('token'):'';
window.history.replaceState(null,'',window.location.pathname);
if(typeof invitationToken!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(invitationToken))invitationToken='';
fragment.delete('token');

const form=document.querySelector('#join-form');
const password=document.querySelector('#password');
const confirmation=document.querySelector('#password-confirm');
const button=document.querySelector('#join-button');
const buttonText=document.querySelector('#join-button-text');
const errorMessage=document.querySelector('#join-error');
const title=document.querySelector('#join-title');
const description=document.querySelector('#join-description');
const result=document.querySelector('#join-result');
const resultText=document.querySelector('#join-result-text');
let submitting=false,finished=false;

function showError(message){errorMessage.textContent=message;errorMessage.hidden=!message;}
function unusableLink(){
  invitationToken='';form.hidden=true;title.textContent='链接不可用';
  description.textContent='请向管理员索取新的入驻或密码重设链接。';
}
function setPending(value){
  submitting=value;button.disabled=value||finished;password.disabled=value;confirmation.disabled=value;
  form.setAttribute('aria-busy',String(value));buttonText.textContent=value?'正在设置':'确认设置';
}
function readableError(body,status){
  if(status===429)return '操作过于频繁，请稍后重试。';
  if(status>=500)return '暂时无法设置密码，请稍后重试。';
  const message=typeof body?.error==='string'?body.error:typeof body?.message==='string'?body.message:'';
  // A server may include diagnostics in an error; never echo a submitted secret.
  return message&&!message.includes(invitationToken)&&!message.includes(password.value)&&!message.includes(confirmation.value)?message.slice(0,180):'密码未设置，请重试。';
}

if(!invitationToken)unusableLink();

form.addEventListener('submit',async event=>{
  event.preventDefault();if(submitting||finished||!invitationToken)return;
  showError('');
  if(password.value.length<12){showError('密码至少需要12个字符。');password.focus();return;}
  if(new TextEncoder().encode(password.value).length>1024){showError('密码过长，请控制在1024字节以内。');password.focus();return;}
  if(password.value!==confirmation.value){showError('两次输入的密码不一致。');confirmation.focus();return;}
  const credentials={token:invitationToken,password:password.value};setPending(true);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch('/api/erp/invitations/accept',{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(credentials)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===410){unusableLink();return;}showError(readableError(body,response.status));return;}
    if(typeof body?.employee?.id!=='string'||typeof body.employee.username!=='string'){showError('尚未收到设置结果，请稍后重试。');return;}
    finished=true;invitationToken='';form.hidden=true;title.textContent='密码已设置';description.textContent='';description.hidden=true;
    resultText.textContent=`请使用账号 ${body.employee.username} 登录办公室。`;result.hidden=false;
    document.querySelector('#login-link').focus();
  }catch{showError('连接中断，请检查网络后重试。');}
  finally{
    clearTimeout(timeout);credentials.token='';credentials.password='';password.value='';confirmation.value='';setPending(false);
    if(!form.hidden&&!errorMessage.hidden)password.focus();
  }
});
