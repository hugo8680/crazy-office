const ROLE_NAMES = Object.freeze({admin:'管理员',manager:'负责人',procurement:'采购',warehouse:'仓管',project_manager:'项目经理',employee:'员工',finance:'财务',hr:'人事'});

// requestRaw has the native fetch signature and returns a Response. The caller
// receives public session data only; credentials are never retained or logged.
export function mountSession({container=document.body,requestRaw=(...args)=>fetch(...args),onAuthenticated=()=>{},onSignedOut=()=>{},onSessionExpired=()=>{},onChange=()=>{},onClose=()=>{}}={}) {
  const dialog=document.createElement('dialog');
  dialog.className='session-dialog';
  dialog.dataset.view='login';
  dialog.setAttribute('aria-labelledby','session-title');
  const spinner=id=>`<svg id="${id}" class="session-spinner" viewBox="0 0 24 24" aria-hidden="true" hidden><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8"/></svg>`;
  const fieldIcon=kind=>`<svg class="session-field-icon" viewBox="0 0 24 24" aria-hidden="true">${kind==='account'?'<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>':'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>'}</svg>`;
  dialog.innerHTML=`<section class="session-card">
    <aside class="session-identity" aria-label="莱森购办公室">
      <div class="session-brand"><img src="./brand-mark.svg" alt="莱森购" width="32" height="32"><span>LAISENGOU</span></div>
      <div class="session-pass-art" aria-hidden="true"><svg viewBox="0 0 240 210"><path d="m28 91 91-48 94 47-92 50Z" fill="#c4d4c6"/><path d="m28 91 93 49v44l-93-48Z" fill="#9eb8a6"/><path d="m121 140 92-50v45l-92 49Z" fill="#dbe5d4"/><path d="m50 97 67-35 70 34-68 35Z" fill="#f4eee0"/><path d="m61 99 55-28 58 28-55 28Z" fill="#e4d5b4"/><path d="m76 88 27-14 31 15-27 14Z" fill="#fffdf5"/><path d="m76 88 31 15v17L76 105Z" fill="#adc6b6"/><path d="m107 103 27-14v17l-27 14Z" fill="#89aa99"/><path d="m148 101 18-9 18 9-18 10Z" fill="#668a76"/><path d="M166 101V72" stroke="#6e8e76" stroke-width="5" stroke-linecap="round"/><circle cx="158" cy="71" r="14" fill="#b9cea5"/><circle cx="173" cy="63" r="17" fill="#d0deba"/><path d="m144 130 15-8 18 9-15 8Z" fill="#dfb179"/><path d="m144 130 18 9v8l-18-9Z" fill="#bf9764"/><path d="m162 139 15-8v8l-15 8Z" fill="#edd0a0"/><path d="m51 155 68 36 73-38" fill="none" stroke="#b5c7b8" stroke-width="1.2"/></svg></div>
      <div class="session-identity-copy"><span class="session-access-label">员工通行证</span><strong id="session-card-name">莱森购办公室</strong><span id="session-card-department">吉林云投莱森购数字科技有限公司</span></div>
      <div class="session-pass-foot" aria-hidden="true"><span>OFFICE</span><svg viewBox="0 0 62 12"><path d="M1 0v12M5 0v12M10 0v12M13 0v12M19 0v12M23 0v12M26 0v12M32 0v12M37 0v12M40 0v12M46 0v12M51 0v12M55 0v12M60 0v12"/></svg></div>
    </aside>
    <div class="session-body">
    <header class="session-heading"><div class="session-heading-main"><span class="session-mark" aria-hidden="true" hidden><svg viewBox="0 0 32 32"><g data-session-icon="login"><path d="M15 5h10v22H15M5 16h14m-4-4 4 4-4 4"/><circle cx="22" cy="16" r=".7"/></g><g data-session-icon="profile"><rect x="4" y="4" width="24" height="24" rx="7"/><circle cx="16" cy="13" r="4"/><path d="M9 24a7 7 0 0 1 14 0"/></g><g data-session-icon="password"><circle cx="12" cy="12" r="7"/><circle cx="10" cy="10" r="1.5"/><path d="m17 17 10 10m-4-4 3-3m-7-1 3-3"/></g><g data-session-icon="invitation"><rect x="3" y="7" width="26" height="20" rx="5"/><path d="m4 10 12 9 12-9M13 5h6"/><path d="m11 23 3 3 7-7"/></g></svg></span><h1 id="session-title">登录</h1></div><button type="button" class="session-close" data-session-action="close" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <p class="session-message" id="session-message" aria-live="polite" hidden></p>
    <form id="session-login-form" class="session-form">
      <fieldset class="session-fields" aria-labelledby="session-title"><label for="session-username"><span class="session-field-label">企业邮箱</span><span class="session-input">${fieldIcon('account')}<input id="session-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80" inputmode="email" placeholder="name@laisengou.com" required></span></label>
      <label for="session-password"><span class="session-field-label">密码</span><span class="session-input">${fieldIcon('password')}<input id="session-password" name="password" type="password" autocomplete="current-password" required><button type="button" class="session-password-toggle" data-session-action="toggle-password" aria-label="显示密码" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button></span></label></fieldset>
      <p class="session-error" id="session-login-error" role="alert" hidden></p>
      <button id="session-login-submit" class="session-primary" type="submit">${spinner('session-login-spinner')}<span id="session-login-label">进入办公室</span><svg class="session-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5"/></svg></button>
    </form>
    <section id="session-profile" hidden>
      <div class="session-profile-card"><div class="session-person"><span class="session-avatar" id="session-initial" aria-hidden="true"></span><div class="session-person-copy"><h2 id="session-name"></h2><p id="session-account"></p></div></div>
      <dl class="session-facts"><div><dt>部门</dt><dd id="session-department"></dd></div><div><dt>岗位</dt><dd id="session-position"></dd></div><div><dt>角色</dt><dd id="session-roles"></dd></div></dl></div>
      <p class="session-error" id="session-profile-error" role="alert" hidden></p>
      <div class="session-profile-actions"><button type="button" data-session-action="password" id="session-password-entry" class="session-secondary"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-3-3 2-2m-5-1 2-2"/></svg>修改密码</button><button type="button" data-session-action="signout" id="session-signout-submit" class="session-signout">${spinner('session-signout-spinner')}<span id="session-signout-label">退出登录</span></button></div>
    </section>
    <form id="session-password-form" class="session-form" hidden>
      <fieldset class="session-fields" aria-labelledby="session-title"><label for="session-current"><span class="session-field-label">原密码</span><span class="session-input">${fieldIcon('password')}<input id="session-current" name="currentPassword" type="password" autocomplete="current-password" required></span></label>
      <label for="session-new"><span class="session-field-label">新密码</span><span class="session-input">${fieldIcon('password')}<input id="session-new" name="newPassword" type="password" autocomplete="new-password" minlength="12" required></span><span class="session-field-note">至少 12 个字符</span></label>
      <label for="session-confirm"><span class="session-field-label">确认新密码</span><span class="session-input">${fieldIcon('password')}<input id="session-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></span></label></fieldset>
      <p class="session-error" id="session-password-error" role="alert" hidden></p>
      <div class="session-form-actions"><button type="button" data-session-action="profile" class="session-secondary">取消</button><button id="session-password-submit" class="session-primary" type="submit">${spinner('session-password-spinner')}<span id="session-password-label">保存密码</span></button></div>
    </form>
    <form id="session-invitation-form" class="session-form" hidden>
      <fieldset class="session-fields" aria-labelledby="session-title"><label for="session-invitation-password"><span class="session-field-label">新密码</span><span class="session-input">${fieldIcon('password')}<input id="session-invitation-password" type="password" autocomplete="new-password" minlength="12" required></span><span class="session-field-note">至少 12 个字符</span></label>
      <label for="session-invitation-confirm"><span class="session-field-label">确认新密码</span><span class="session-input">${fieldIcon('password')}<input id="session-invitation-confirm" type="password" autocomplete="new-password" minlength="12" required></span></label></fieldset>
      <p class="session-error" id="session-invitation-error" role="alert" hidden></p>
      <button id="session-invitation-submit" class="session-primary" type="submit">${spinner('session-invitation-spinner')}<span id="session-invitation-label">设置密码</span></button>
    </form>
    </div>
  </section>`;
  container.append(dialog);
  const q=selector=>dialog.querySelector(selector);
  const login=q('#session-login-form'),profile=q('#session-profile'),passwordForm=q('#session-password-form'),invitationForm=q('#session-invitation-form');
  const username=q('#session-username'),password=q('#session-password'),current=q('#session-current'),next=q('#session-new'),confirmation=q('#session-confirm');
  const invitationPassword=q('#session-invitation-password'),invitationConfirmation=q('#session-invitation-confirm');
  const pendingActions=[['login','login','进入办公室','正在进入'],['profile','signout','退出登录','正在退出'],['password','password','保存密码','正在保存'],['invitation','invitation','设置密码','正在保存']];
  let session=null,mode='login',pending=false,destroyed=false,generation=0,expiryTimer=null,returnFocus=null,closeTimer=null,closing=false,surfaceOpen=false,surfaceGeneration=0,closeGeneration=0,restoreCloseFocus=true;
  const fragment=new URLSearchParams(window.location.hash.slice(1));
  const hasToken=fragment.has('token'),tokenValues=fragment.getAll('token');
  let invitationToken=tokenValues.length===1&&/^[A-Za-z0-9_-]{43}$/.test(tokenValues[0])?tokenValues[0]:'';
  let invalidInvitation=(hasToken&&!invitationToken)||(!hasToken&&/^\/join(?:\.html)?\/?$/.test(window.location.pathname));
  // Remove invitation secrets before any network request or view callback.
  fragment.delete('token');tokenValues.fill('');
  if(hasToken||invalidInvitation)window.history.replaceState(null,'','/');
  const controllers=new Map();
  const notify=(fn,...args)=>{try{const result=fn(...args);if(result&&typeof result.catch==='function')result.catch(()=>{});}catch{}};
  const clearPasswords=()=>{for(const field of [password,current,next,confirmation,invitationPassword,invitationConfirmation])field.value='';password.type='password';const toggle=q('[data-session-action="toggle-password"]');toggle?.setAttribute('aria-label','显示密码');toggle?.setAttribute('aria-pressed','false');};
  function message(selector,text=''){
    const element=q(selector);
    if(element.textContent===text&&element.hidden===!text)return;
    element.textContent=text;element.hidden=!text;
  }
  function setPending(value){
    pending=value;dialog.setAttribute('aria-busy',String(value));
    for(const control of dialog.querySelectorAll('input,button'))control.disabled=value||closing;
    for(const [view,id,idle,busy] of pendingActions){
      const active=value&&view===mode,button=q(`#session-${id}-submit`);
      button.dataset.busy=String(active);button.setAttribute('aria-busy',String(active));
      q(`#session-${id}-label`).textContent=active?busy:idle;
      q(`#session-${id}-spinner`).hidden=!active;
    }
  }
  function didClose(){
    if(destroyed||dialog.open||!surfaceOpen)return;
    surfaceOpen=false;surfaceGeneration++;closeGeneration++;clearTimeout(closeTimer);closeTimer=null;closing=false;delete dialog.dataset.closing;clearPasswords();setPending(pending);
    const focus=returnFocus;returnFocus=null;if(restoreCloseFocus&&focus?.isConnected)focus.focus();restoreCloseFocus=true;
    notify(onClose);
  }
  function cancelClose(){
    closeGeneration++;if(!closing)return;
    clearTimeout(closeTimer);closeTimer=null;closing=false;delete dialog.dataset.closing;setPending(pending);
  }
  function dismiss(restoreFocus=true){
    clearPasswords();
    if(!dialog.open||closing)return;
    const ticket=++closeGeneration,surface=surfaceGeneration;restoreCloseFocus=restoreFocus;
    const finish=()=>{
      if(destroyed||ticket!==closeGeneration||surface!==surfaceGeneration||!dialog.open)return;
      dialog.close();didClose();
    };
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){finish();return;}
    closing=true;dialog.dataset.closing='true';setPending(pending);
    closeTimer=setTimeout(finish,140);
  }
  function setSession(value){
    session=value?.authenticated===true?value:null;
    clearTimeout(expiryTimer);expiryTimer=null;
    if(session){
      const actor=session.actor||session,name=actor.name||session.username||'账户';
      q('#session-initial').textContent=Array.from(name)[0]||'';
      q('#session-name').textContent=name;
      q('#session-account').textContent=session.username||actor.username||'';
      q('#session-department').textContent=(Array.isArray(actor.departments)&&actor.departments.length?actor.departments.join('、'):actor.department)||'—';
      q('#session-position').textContent=actor.title||'—';
      q('#session-card-name').textContent=name;
      q('#session-card-department').textContent=actor.department||'莱森购办公室';
      q('#session-roles').textContent=(actor.roles||[]).map(role=>ROLE_NAMES[role]).filter(Boolean).join('、')||'—';
      q('#session-password-entry').hidden=actor.source==='legacy';
      const expiry=Date.parse(session.expiresAt||actor.expiresAt||'');
      if(Number.isFinite(expiry))expiryTimer=setTimeout(()=>requireLogin('登录已过期，请重新登录。'),Math.min(2147483647,Math.max(0,expiry-Date.now())));
    }else{
      q('#session-card-name').textContent='莱森购办公室';q('#session-card-department').textContent='吉林云投莱森购数字科技有限公司';
      for(const selector of ['#session-initial','#session-name','#session-account','#session-department','#session-position','#session-roles'])q(selector).textContent='';
    }
    notify(onChange,session);
  }
  function show(view,notice='',reset=false){
    if(destroyed)return;
    const opened=dialog.open,changed=mode!==view,reopening=closing,entering=!opened||changed||reopening||reset;
    cancelClose();
    mode=view;
    dialog.dataset.view=view;
    login.hidden=view!=='login';profile.hidden=view!=='profile';passwordForm.hidden=view!=='password';invitationForm.hidden=view!=='invitation';
    q('#session-title').textContent=view==='login'?'登录':view==='password'?'修改密码':view==='invitation'?'设置密码':'账户';
    if(entering){
      message('#session-message',notice);
      for(const selector of ['#session-login-error','#session-profile-error','#session-password-error','#session-invitation-error'])message(selector);
      clearPasswords();
    }else if(notice)message('#session-message',notice);
    if(view==='login'&&!username.value)username.value=session?.username||'';
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();surfaceOpen=true;surfaceGeneration++;restoreCloseFocus=true;}
    const focus=view==='login'?(username.value?password:username):view==='password'?current:view==='invitation'?invitationPassword:q('.session-close');
    if(entering)focus.focus();
  }
  function close(){if(pending||destroyed)return;dismiss();}
  function open(){if(pending||destroyed)return;show(invitationToken?'invitation':session?'profile':'login');}
  function requireLogin(notice='请登录。'){
    if(destroyed)return;
    for(const [controller,timeout] of controllers){clearTimeout(timeout);controller.abort();}controllers.clear();
    const expired=Boolean(session);generation++;setSession(null);setPending(false);show('login',notice,true);
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
      invalidInvitation=false;setSession(data.session);setPending(false);dismiss(false);notify(onAuthenticated,session);
    }catch(error){if(!destroyed&&stamp===generation)message('#session-login-error',errorText(error,'login'));}
    finally{credentials.password='';if(!destroyed&&stamp===generation){password.value='';setPending(false);if(!q('#session-login-error').hidden)password.focus();}}
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
    }finally{credentials.currentPassword='';credentials.newPassword='';if(!destroyed&&stamp===generation){clearPasswords();setPending(false);}}
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
    }}finally{credentials.token='';credentials.password='';if(!destroyed&&stamp===generation){clearPasswords();setPending(false);}}
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
      else if(session){if(dialog.open&&mode==='login')dismiss(false);notify(onAuthenticated,session);}
      else{show('login',wasAuthenticated?'登录已过期，请重新登录。':'');if(wasAuthenticated)notify(onSessionExpired);}
      return session;
    }catch(error){if(!destroyed&&stamp===generation){const wasAuthenticated=Boolean(session);setSession(null);show(invitationToken?'invitation':'login');message(invitationToken?'#session-invitation-error':'#session-login-error',errorText(error,'refresh'));if(wasAuthenticated)notify(onSessionExpired);}return null;}
  }
  function onClick(event){
    const button=event.target.closest('[data-session-action]');
    if(!button||pending)return;
    switch(button.dataset.sessionAction){case 'toggle-password':{const visible=password.type==='password';password.type=visible?'text':'password';button.setAttribute('aria-label',visible?'隐藏密码':'显示密码');button.setAttribute('aria-pressed',String(visible));password.focus();break;}case 'close':close();break;case 'password':show('password');break;case 'profile':show(session?'profile':'login');break;case 'signout':void signOut();break;}
  }
  function onCancel(event){event.preventDefault();if(!pending)close();}
  function onVisibility(){if(!destroyed&&!document.hidden&&session)void refresh();}
  dialog.addEventListener('click',onClick);dialog.addEventListener('cancel',onCancel);dialog.addEventListener('close',didClose);
  login.addEventListener('submit',submitLogin);passwordForm.addEventListener('submit',submitPassword);invitationForm.addEventListener('submit',submitInvitation);
  document.addEventListener('visibilitychange',onVisibility);
  const ready=invitationToken?(show('invitation'),Promise.resolve(null)):invalidInvitation?(show('login','链接已失效，请联系管理员。'),Promise.resolve(null)):refresh();
  return {ready,open,close,requireLogin,refresh,signOut,get session(){return session;},get isOpen(){return dialog.open;},destroy(){
    if(destroyed)return;destroyed=true;generation++;invitationToken='';clearTimeout(expiryTimer);clearTimeout(closeTimer);closeTimer=null;for(const [controller,timeout] of controllers){clearTimeout(timeout);controller.abort();}controllers.clear();clearPasswords();
    login.removeEventListener('submit',submitLogin);passwordForm.removeEventListener('submit',submitPassword);invitationForm.removeEventListener('submit',submitInvitation);dialog.removeEventListener('click',onClick);dialog.removeEventListener('cancel',onCancel);dialog.removeEventListener('close',didClose);document.removeEventListener('visibilitychange',onVisibility);dialog.close();dialog.remove();session=null;
  }};
}
