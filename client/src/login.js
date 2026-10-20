const form=document.querySelector('#login-form');
const account=document.querySelector('#username');
const password=document.querySelector('#password');
const button=document.querySelector('#login-button');
const buttonText=document.querySelector('#login-button-text');
const errorMessage=document.querySelector('#login-error');
let submitting=false;

function showError(message){errorMessage.textContent=message;errorMessage.hidden=!message;}
function setPending(value){
  submitting=value;button.disabled=value;account.disabled=value;password.disabled=value;
  form.setAttribute('aria-busy',String(value));buttonText.textContent=value?'正在登录':'登录';
}
function readableError(body,status){
  const message=typeof body?.error==='string'?body.error:typeof body?.message==='string'?body.message:'';
  if(message)return message.slice(0,240);
  if(status===401)return '账号或密码错误。';
  if(status===429)return '登录尝试过多，请稍后重试。';
  return '暂时无法登录，请稍后重试。';
}

form.addEventListener('submit',async event=>{
  event.preventDefault();if(submitting||!form.reportValidity())return;
  const credentials={username:account.value.trim(),password:password.value};
  showError('');setPending(true);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch('/api/session/login',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(credentials)});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){showError(readableError(body,response.status));return;}
    if(body?.session?.authenticated!==true){showError('登录未完成，请重试。');return;}
    window.location.assign('/');
  }catch{showError('无法连接办公室，请检查网络后重试。');}
  finally{
    clearTimeout(timeout);
    credentials.password='';password.value='';setPending(false);
    if(!errorMessage.hidden)password.focus();
  }
});

fetch('/api/session',{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}})
  .then(response=>response.ok?response.json():null)
  .then(body=>{if(body?.session?.authenticated)window.location.assign('/');})
  .catch(()=>{});
