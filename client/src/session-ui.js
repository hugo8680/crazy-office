const ROLE_NAMES = Object.freeze({admin:'管理员',manager:'负责人',procurement:'采购',warehouse:'仓管',project_manager:'项目经理',employee:'员工',finance:'财务',hr:'人事'});

// requestRaw has the native fetch signature and returns a Response. The caller
// receives public session data only; credentials are never retained or logged.
export function mountSession({container=document.body,requestRaw=(...args)=>fetch(...args),onAuthenticated=()=>{},onSignedOut=()=>{},onSessionExpired=()=>{},onChange=()=>{}}={}) {
  const dialog=document.createElement('dialog');
  dialog.className='session-dialog';
  dialog.setAttribute('aria-labelledby','session-title');
  dialog.innerHTML=`<section class="session-card">
    <header class="session-heading"><span class="session-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 18V9l8-5 8 5v9M4 18h16M9 18v-6h6v6"/></svg></span><button type="button" class="session-close" data-session-action="close" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <h1 id="session-title">登录</h1>
    <p class="session-message" id="session-message" aria-live="polite" hidden></p>
    <form id="session-login-form" class="session-form">
      <label for="session-username">账号<input id="session-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80" required></label>
      <label for="session-password">密码<input id="session-password" name="password" type="password" autocomplete="current-password" required></label>
      <p class="session-error" id="session-login-error" role="alert" hidden></p>
      <button class="session-primary" type="submit">登录<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5"/></svg></button>
    </form>
    <section id="session-profile" hidden>
      <div class="session-person"><span class="session-avatar" id="session-initial" aria-hidden="true"></span><div><h2 id="session-name"></h2><p id="session-account"></p></div></div>
      <dl class="session-facts"><div><dt>部门</dt><dd id="session-department"></dd></div><div><dt>岗位</dt><dd id="session-position"></dd></div><div><dt>角色</dt><dd id="session-roles"></dd></div></dl>
      <p class="session-error" id="session-profile-error" role="alert" hidden></p>
      <div class="session-profile-actions"><button type="button" data-session-action="password" id="session-password-entry" class="session-secondary">修改密码</button><button type="button" data-session-action="signout" class="session-signout">退出登录</button></div>
    </section>
    <form id="session-password-form" class="session-form" hidden>
      <label for="session-current">原密码<input id="session-current" name="currentPassword" type="password" autocomplete="current-password" required></label>
      <label for="session-new">新密码<input id="session-new" name="newPassword" type="password" autocomplete="new-password" minlength="12" required><span class="session-field-note">至少 12 个字符</span></label>
      <label for="session-confirm">确认新密码<input id="session-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label>
      <p class="session-error" id="session-password-error" role="alert" hidden></p>
      <div class="session-form-actions"><button type="button" data-session-action="profile" class="session-secondary">取消</button><button class="session-primary" type="submit">保存密码</button></div>
    </form>
    <form id="session-invitation-form" class="session-form" hidden>
      <label for="session-invitation-password">新密码<input id="session-invitation-password" type="password" autocomplete="new-password" minlength="12" required><span class="session-field-note">至少 12 个字符</span></label>
      <label for="session-invitation-confirm">确认新密码<input id="session-invitation-confirm" type="password" autocomplete="new-password" minlength="12" required></label>
      <p class="session-error" id="session-invitation-error" role="alert" hidden></p>
      <button class="session-primary" type="submit">设置密码</button>
    </form>
  </section>`;
  container.append(dialog);
  const q=selector=>dialog.querySelector(selector);
  const login=q('#session-login-form'),profile=q('#session-profile'),passwordForm=q('#session-password-form'),invitationForm=q('#session-invitation-form');
  const username=q('#session-username'),password=q('#session-password'),current=q('#session-current'),next=q('#session-new'),confirmation=q('#session-confirm');
  const invitationPassword=q('#session-invitation-password'),invitationConfirmation=q('#session-invitation-confirm');
  let session=null,mode='login',pending=false,destroyed=false,generation=0,expiryTimer=null,returnFocus=null;
  const fragment=new URLSearchParams(window.location.hash.slice(1));
  const hasToken=fragment.has('token'),tokenValues=fragment.getAll('token');
  let invitationToken=tokenValues.length===1&&/^[A-Za-z0-9_-]{43}$/.test(tokenValues[0])?tokenValues[0]:'';
  let invalidInvitation=(hasToken&&!invitationToken)||(!hasToken&&/^\/join(?:\.html)?\/?$/.test(window.location.pathname));
  // Remove invitation secrets before any network request or view callback.
  fragment.delete('token');tokenValues.fill('');
  if(hasToken||invalidInvitation)window.history.replaceState(null,'','/');
  const controllers=new Map();
  const notify=(fn,...args)=>{try{const result=fn(...args);if(result&&typeof result.catch==='function')result.catch(()=>{});}catch{}};
  const clearPasswords=()=>{for(const field of [password,current,next,confirmation,invitationPassword,invitationConfirmation])field.value='';};
  function message(selector,text=''){const element=q(selector);element.textContent=text;element.hidden=!text;}
  function setPending(value){pending=value;dialog.setAttribute('aria-busy',String(value));for(const control of dialog.querySelectorAll('input,button'))control.disabled=value;}
  function setSession(value){
    session=value?.authenticated===true?value:null;
    clearTimeout(expiryTimer);expiryTimer=null;
    if(session){
      const actor=session.actor||session,name=actor.name||session.username||'账户';
      q('#session-initial').textContent=Array.from(name)[0]||'';
      q('#session-name').textContent=name;
      q('#session-account').textContent=session.username||actor.username||'';
      q('#session-department').textContent=actor.department||'—';
      q('#session-position').textContent=actor.title||'—';
      q('#session-roles').textContent=(actor.roles||[]).map(role=>ROLE_NAMES[role]).filter(Boolean).join('、')||'—';
      q('#session-password-entry').hidden=actor.source==='legacy';
      const expiry=Date.parse(session.expiresAt||actor.expiresAt||'');
      if(Number.isFinite(expiry))expiryTimer=setTimeout(()=>requireLogin('登录已过期，请重新登录。'),Math.min(2147483647,Math.max(0,expiry-Date.now())));
    }else{
      for(const selector of ['#session-initial','#session-name','#session-account','#session-department','#session-position','#session-roles'])q(selector).textContent='';
    }
    notify(onChange,session);
  }
  function show(view,notice=''){
    if(destroyed)return;
    mode=view;
    login.hidden=view!=='login';profile.hidden=view!=='profile';passwordForm.hidden=view!=='password';invitationForm.hidden=view!=='invitation';
    q('#session-title').textContent=view==='login'?'登录':view==='password'?'修改密码':view==='invitation'?'设置密码':'账户';
    message('#session-message',notice);
    for(const selector of ['#session-login-error','#session-profile-error','#session-password-error','#session-invitation-error'])message(selector);
    clearPasswords();
    if(view==='login'&&!username.value)username.value=session?.username||'';
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    const focus=view==='login'?(username.value?password:username):view==='password'?current:view==='invitation'?invitationPassword:q('.session-close');
    focus.focus();
  }
  function close(){if(pending||destroyed)return;clearPasswords();dialog.close();if(returnFocus?.isConnected)returnFocus.focus();}
  function open(){show(invitationToken?'invitation':session?'profile':'login');}
  function requireLogin(notice='请登录。'){
    if(destroyed)return;
    for(const [controller,timeout] of controllers){clearTimeout(timeout);controller.abort();}controllers.clear();
    const expired=Boolean(session);generation++;setSession(null);setPending(false);show('login',notice);
    if(expired)notify(onSessionExpired);
  }
  async function request(url,body){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    controllers.set(controller,timeout);
    try{
      const response=await requestRaw(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw Object.assign(new Error('request failed'),{status:response.status,data});
      return data;
    }finally{clearTimeout(timeout);controllers.delete(controller);}
  }
  function errorText(error,kind){
    if(error.status===429)return '尝试过多，请稍后再试。';
    if(error.status===403)return '请求未通过校验，请刷新后重试。';
    if(error.status===401)return kind==='password'&&error.data?.error==='原密码不正确。'?'原密码不正确。':kind==='login'?'账号或密码不正确。':'登录已过期，请重新登录。';
    if(error.status===409&&kind==='password')return error.data?.error==='管理员原始登录口令由服务器配置维护。'?'此账号由管理员维护。':'账号已更新，请重新登录。';
    if(error.status===400&&kind==='password')return '新密码不符合要求。';
    return error.status?'暂时无法完成，请稍后重试。':'连接中断，请重试。';
  }
  async function submitLogin(event){
    event.preventDefault();if(pending||destroyed||!login.reportValidity())return;
    const credentials={username:username.value.trim(),password:password.value};
    if(!credentials.username){message('#session-login-error','请输入账号。');username.focus();return;}
    if(credentials.username.length>80||new TextEncoder().encode(credentials.password).length>1024){message('#session-login-error','账号或密码过长。');clearPasswords();return;}
    const stamp=++generation;message('#session-login-error');setPending(true);
    try{
      const data=await request('/api/session/login',credentials);
      if(destroyed||stamp!==generation)return;
      if(data.session?.authenticated!==true)throw new Error('invalid session');
      invalidInvitation=false;setSession(data.session);setPending(false);clearPasswords();dialog.close();notify(onAuthenticated,session);
    }catch(error){if(!destroyed&&stamp===generation)message('#session-login-error',errorText(error,'login'));}
    finally{credentials.password='';password.value='';if(!destroyed&&stamp===generation){setPending(false);if(!q('#session-login-error').hidden)password.focus();}}
  }
  async function signOut(){
    if(pending||destroyed)return false;
    const stamp=++generation;setPending(true);message('#session-profile-error');
    try{
      await request('/api/session/logout',{});
      if(destroyed||stamp!==generation)return false;
      setSession(null);setPending(false);notify(onSignedOut);show('login');return true;
    }catch(error){if(!destroyed&&stamp===generation)message('#session-profile-error',errorText(error,'signout'));return false;}
    finally{if(!destroyed&&stamp===generation)setPending(false);}
  }
  async function submitPassword(event){
    event.preventDefault();if(pending||destroyed||!session||!passwordForm.reportValidity())return;
    if(next.value.length<12){message('#session-password-error','新密码至少 12 个字符。');return;}
    if(new TextEncoder().encode(next.value).length>1024||new TextEncoder().encode(current.value).length>1024){message('#session-password-error','密码过长。');return;}
    if(next.value!==confirmation.value){message('#session-password-error','两次新密码不一致。');confirmation.focus();return;}
    const credentials={currentPassword:current.value,newPassword:next.value},stamp=++generation;
    setPending(true);message('#session-password-error');
    try{
      const data=await request('/api/erp/identity/password',credentials);
      if(destroyed||stamp!==generation)return;
      if(data.ok!==true)throw new Error('invalid password response');
      setSession(null);setPending(false);notify(onSignedOut);show('login','密码已修改，请登录。');
    }catch(error){
      if(!destroyed&&stamp===generation){
        if((error.status===401&&error.data?.error!=='原密码不正确。')||(error.status===409&&error.data?.error!=='管理员原始登录口令由服务器配置维护。'))requireLogin('登录已过期，请重新登录。');
        else message('#session-password-error',errorText(error,'password'));
      }
    }finally{credentials.currentPassword='';credentials.newPassword='';clearPasswords();if(!destroyed&&stamp===generation)setPending(false);}
  }
  async function submitInvitation(event){
    event.preventDefault();if(pending||destroyed||!invitationToken||!invitationForm.reportValidity())return;
    if(invitationPassword.value.length<12){message('#session-invitation-error','密码至少 12 个字符。');return;}
    if(new TextEncoder().encode(invitationPassword.value).length>1024){message('#session-invitation-error','密码过长。');return;}
    if(invitationPassword.value!==invitationConfirmation.value){message('#session-invitation-error','两次新密码不一致。');invitationConfirmation.focus();return;}
    const credentials={token:invitationToken,password:invitationPassword.value},stamp=++generation;
    setPending(true);message('#session-invitation-error');
    try{
      const data=await request('/api/erp/invitations/accept',credentials);
      if(destroyed||stamp!==generation)return;
      if(typeof data.employee?.id!=='string'||typeof data.employee?.username!=='string')throw new Error('invalid invitation response');
      invitationToken='';invalidInvitation=false;username.value=data.employee.username;
      // The successful acceptance response clears the old HttpOnly cookie.
      // It deliberately never grants a session to the accepted employee.
      setSession(null);setPending(false);notify(onSignedOut);show('login','密码已设置，请登录。');
    }catch(error){if(!destroyed&&stamp===generation){
      if(error.status===410){invitationToken='';setPending(false);show('login','链接已失效，请联系管理员。');}
      else message('#session-invitation-error',errorText(error,'invitation'));
    }}finally{credentials.token='';credentials.password='';clearPasswords();if(!destroyed&&stamp===generation)setPending(false);}
  }
  async function refresh(){
    if(destroyed||pending)return session;
    const stamp=++generation;
    try{
      const data=await request('/api/session');
      if(destroyed||stamp!==generation)return session;
      const wasAuthenticated=Boolean(session);
      setSession(data.session);
      if(invitationToken)show('invitation');
      else if(session){if(dialog.open&&mode==='login')dialog.close();notify(onAuthenticated,session);}
      else{show('login',wasAuthenticated?'登录已过期，请重新登录。':'');if(wasAuthenticated)notify(onSessionExpired);}
      return session;
    }catch(error){if(!destroyed&&stamp===generation){const wasAuthenticated=Boolean(session);setSession(null);show(invitationToken?'invitation':'login');message(invitationToken?'#session-invitation-error':'#session-login-error',errorText(error,'refresh'));if(wasAuthenticated)notify(onSessionExpired);}return null;}
  }
  function onClick(event){
    const button=event.target.closest('[data-session-action]');
    if(!button||pending)return;
    switch(button.dataset.sessionAction){case 'close':close();break;case 'password':show('password');break;case 'profile':show(session?'profile':'login');break;case 'signout':void signOut();break;}
  }
  function onCancel(event){if(pending)event.preventDefault();else clearPasswords();}
  function onVisibility(){if(!destroyed&&!document.hidden&&session)void refresh();}
  dialog.addEventListener('click',onClick);dialog.addEventListener('cancel',onCancel);
  login.addEventListener('submit',submitLogin);passwordForm.addEventListener('submit',submitPassword);invitationForm.addEventListener('submit',submitInvitation);
  document.addEventListener('visibilitychange',onVisibility);
  const ready=invitationToken?(show('invitation'),Promise.resolve(null)):invalidInvitation?(show('login','链接已失效，请联系管理员。'),Promise.resolve(null)):refresh();
  return {ready,open,close,requireLogin,refresh,signOut,get session(){return session;},destroy(){
    if(destroyed)return;destroyed=true;generation++;invitationToken='';clearTimeout(expiryTimer);for(const [controller,timeout] of controllers){clearTimeout(timeout);controller.abort();}controllers.clear();clearPasswords();
    login.removeEventListener('submit',submitLogin);passwordForm.removeEventListener('submit',submitPassword);invitationForm.removeEventListener('submit',submitInvitation);dialog.removeEventListener('click',onClick);dialog.removeEventListener('cancel',onCancel);document.removeEventListener('visibilitychange',onVisibility);dialog.close();dialog.remove();session=null;
  }};
}
