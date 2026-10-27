import {escapeHtml as e,dateText,list} from './erp-ui.mjs';
import {BULLETIN_SECTIONS,bulletinSection} from './bulletin-sections.mjs';
import {renderOfficeDashboardCharts} from './office-charts.mjs';

const tabs=BULLETIN_SECTIONS.map(({id,title,symbol})=>[id,title,symbol]);
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('zh-CN'):'—';
export function safeBoardVideo(value){if(typeof value!=='string')return '';if(/^\/(media|assets)\/[a-zA-Z0-9_./-]+\.(mp4|webm|ogg)$/.test(value)&&!value.includes('..'))return value;try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
export function renderBoardMetrics(metrics=[]){return `<div class="bulletin-metrics">${list(metrics).map((metric,i)=>`<article><span class="bulletin-metric-index">0${i+1}</span><p>${e(metric.label)}</p><strong>${e(number(metric.value))}</strong><span>${e(metric.unit||'项')}</span></article>`).join('')}</div>`;}
export function renderTrainingRows(entries=[]){return list(entries).length?`<div class="bulletin-table-wrap"><table class="bulletin-table"><thead><tr><th>排名</th><th>员工</th><th>部门</th><th>完成量</th><th>准确率</th></tr></thead><tbody>${entries.map(row=>`<tr><td><b class="bulletin-rank" data-rank="${e(row.rank)}">${e(row.rank)}</b></td><td><strong>${e(row.employeeName)}</strong></td><td>${e(row.department)}</td><td>${e(number(row.completedCount))}</td><td>${e(Number.isFinite(Number(row.accuracy))?Number(row.accuracy).toFixed(2)+'%':'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="bulletin-empty">暂无已登记的标注成绩</div>';}
export function renderBoardMessages(messages={}){return `<div class="bulletin-message-list">${list(messages.items).map(item=>`<article class="bulletin-message" data-message-id="${e(item.id)}"><div class="bulletin-author"><span aria-hidden="true">${icon('user')}</span><strong>${e(item.authorName)}</strong><time>${e(dateText(item.createdAt))}</time>${item.canDelete?`<button type="button" data-bulletin-action="delete-message" data-id="${e(item.id)}" data-version="${e(item.version)}" aria-label="删除这条留言">删除</button>`:''}</div><p>${e(item.body)}</p></article>`).join('')||'<div class="bulletin-empty">还没有留言</div>'}</div>${messages.hasMore?'<button type="button" class="erp-button" data-bulletin-action="more-messages">更早留言</button>':''}`;}

export function renderBoardPreview(section,board={},snapshot={}){
  if(section==='dashboard')return renderOfficeDashboardCharts(snapshot,{compact:true});
  if(section==='training'){
    const rows=list(board.training?.entries).slice(0,3);
    return rows.length?`<ol class="bulletin-preview-ranking">${rows.map(row=>`<li><b>${e(row.rank)}</b><span>${e(row.employeeName)}</span><strong>${e(number(row.completedCount))}</strong><small>${e(Number.isFinite(Number(row.accuracy))?Number(row.accuracy).toFixed(1)+'%':'—')}</small></li>`).join('')}</ol>`:'<p class="bulletin-preview-empty">暂无已登记的标注成绩</p>';
  }
  if(section==='video'){
    const src=safeBoardVideo(board.video?.src);
    return src?`<div class="bulletin-preview-film">${src==='/media/office-film.webm'?'<img src="/media/office-film-poster.svg" alt="" width="288" height="136">':`<div class="bulletin-preview-film-placeholder">${icon('play')}</div>`}<span>${icon('play')}</span></div><p class="bulletin-preview-film-title">${e(board.video?.title||'公司宣传片')}</p>`:'<p class="bulletin-preview-empty">宣传片尚未上传</p>';
  }
  if(section==='messages'){
    const items=list(board.messages?.items).slice(0,2);
    return items.length?`<div class="bulletin-preview-notes">${items.map(item=>`<article><strong>${e(item.authorName)}</strong><p>${e(String(item.body||'').slice(0,100))}</p></article>`).join('')}</div>`:'<p class="bulletin-preview-empty">还没有留言</p>';
  }
  return '';
}

export function mountBulletinCenter({container,chrome,request,session,onError=()=>{},onClose=()=>{},onOpenNotices=()=>{},isBlocked=()=>false,getSnapshot=()=>({}),document:doc=globalThis.document,random=Math.random,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout}={}){
  const dialog=doc.createElement('dialog');dialog.className='bulletin-dialog';dialog.setAttribute('aria-label','信息公开栏');container.append(dialog);
  const previewElement=doc.createElement('aside');previewElement.className='bulletin-preview';previewElement.hidden=true;previewElement.setAttribute('role','tooltip');previewElement.setAttribute('aria-label','公开栏摘要');chrome.append(previewElement);
  let board=null,section='dashboard',destroyed=false,epoch=0,loading=null,error='',busy=false,manage=false,people=[],previewTicket=0,previewSection=null,previewAnchor=null,draft='',trainingDraft={},videoDraft=null,videoSettingsOpen=false,previousFocus=null,expanded=false,nativeFullscreen=false,fullscreenTicket=0,surfaceOpen=false,surfaceGeneration=0;
  const mutationKeys=new Map();
  const actor=session?.actor||session?.user||{},key=()=>globalThis.crypto?.randomUUID?.()||`board-${Date.now()}-${Math.floor(random()*1e9)}`;
  const video=()=>dialog.querySelector('video');
  const empty=text=>`<div class="bulletin-empty">${e(text)}</div>`;
  const field=(label,name,type='text',extra='')=>`<label class="erp-field"><span>${label}</span><input name="${name}" type="${type}" value="${e(trainingDraft[name]||'')}" ${extra} required></label>`;
  const focusControls='button,input,select,textarea,summary,video';
  function focusIdentity(node){
    if(node?.dataset?.bulletinAction)return JSON.stringify(['action',node.dataset.bulletinAction,node.dataset.id||'']);
    if(node?.dataset?.bulletinTab)return JSON.stringify(['tab',node.dataset.bulletinTab]);
    const form=node?.form||node?.closest?.('[data-bulletin-form]');
    if(node?.name&&form?.dataset?.bulletinForm)return JSON.stringify(['field',form.dataset.bulletinForm,node.name]);
    if(node?.type==='submit'&&form?.dataset?.bulletinForm)return JSON.stringify(['submit',form.dataset.bulletinForm]);
    return ['SUMMARY','VIDEO'].includes(node?.tagName)?node.tagName:'';
  }
  function captureView(){
    if(!dialog.open)return null;
    const focused=doc.activeElement,content=dialog.querySelector('.bulletin-content');
    return {section:dialog.dataset.section,top:content?.scrollTop||0,left:content?.scrollLeft||0,focus:dialog.contains?.(focused)?{key:focusIdentity(focused),start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection,top:focused.scrollTop||0,left:focused.scrollLeft||0}:null};
  }
  function restoreView(saved){
    if(!saved||!dialog.open)return;
    const focused=saved.focus,target=focused?.key?[...dialog.querySelectorAll(focusControls)].find(node=>focusIdentity(node)===focused.key):null;
    if(target&&!target.disabled){
      target.focus?.({preventScroll:true});
      if(Number.isInteger(focused.start)&&Number.isInteger(focused.end))try{target.setSelectionRange?.(focused.start,focused.end,focused.direction||'none');}catch{/* Number and date controls do not expose text ranges. */}
      target.scrollTop=focused.top;target.scrollLeft=focused.left;
    }
    const content=dialog.querySelector('.bulletin-content');if(content&&saved.section===section){content.scrollTop=saved.top;content.scrollLeft=saved.left;}
  }
  function render(){if(destroyed)return;const savedView=captureView();dialog.dataset.section=section;captureDrafts();const source=board||{},training=source.training||{},messages=source.messages||{},media=source.video||{},dashboard=source.dashboard||{};
    const title=tabs.find(t=>t[0]===section)?.[1]||'数据看板';let content=empty('正在读取…');
    if(board&&section==='dashboard')content=`<div class="bulletin-dashboard-head"><div><h2>数据看板</h2></div><time>${e(dateText(dashboard.generatedAt))}</time></div>${renderOfficeDashboardCharts(getSnapshot(),{metrics:list(dashboard.metrics)})}<div class="bulletin-dashboard-footer"><span>当前账号可见数据</span><span>${e(actor.name||'')}</span></div>`;
    if(board&&section==='training')content=`<div class="bulletin-section-title"><div><h2>标注排行榜</h2><p>${training.periodStart?`${e(training.periodStart)} — ${e(training.periodEnd)}`:'按完成量排名 · 准确率同步展示'}</p></div>${training.canManage?`<button type="button" class="erp-button" data-bulletin-action="manage-training">${manage?'取消录入':'登记成绩'}</button>`:''}</div>${manage?`<form class="bulletin-training-form erp-form" data-bulletin-form="training"><label class="erp-field"><span>员工</span><select name="employeeId" required><option value="">选择员工</option>${people.filter(p=>p.active!==false&&p.status!=='disabled').map(p=>`<option value="${e(p.id)}" ${trainingDraft.employeeId===p.id?'selected':''}>${e(p.name)} · ${e(p.department||'')}</option>`).join('')}</select></label>${field('开始日期','periodStart','date')}${field('结束日期','periodEnd','date')}${field('完成量','completedCount','number','min="0" step="1"')}${field('准确率 %','accuracy','number','min="0" max="100" step="0.01"')}<button class="erp-button erp-primary" type="submit" ${busy?'disabled':''}>保存成绩</button></form>`:''}${renderTrainingRows(training.entries)}`;
    if(board&&section==='video'){const src=safeBoardVideo(media.src);content=`<div class="bulletin-section-title"><div><h2>${e(media.title||'公司宣传片')}</h2></div></div>${src?`<video class="bulletin-video" controls playsinline preload="metadata" ${src==='/media/office-film.webm'?'poster="/media/office-film-poster.svg"':''} src="${e(src)}" aria-label="${e(media.title||'公司宣传片')}"></video>`:empty('宣传片尚未上传')}${media.canManage?`<details class="bulletin-video-settings" ${videoSettingsOpen?'open':''}><summary>设置宣传视频</summary><form class="erp-form" data-bulletin-form="video"><label class="erp-field"><span>视频地址</span><input name="src" value="${e(videoDraft?.src??media.src??'')}" placeholder="/media/office-film.webm" maxlength="500"></label><label class="erp-field"><span>标题</span><input name="title" value="${e(videoDraft?.title??media.title??'公司宣传片')}" maxlength="80" required></label><button class="erp-button erp-primary" type="submit" ${busy?'disabled':''}>保存</button></form></details>`:''}`;}
    if(board&&section==='messages')content=`<div class="bulletin-section-title"><div><h2>员工留言板</h2></div><span>${list(messages.items).length} 条留言</span></div>${messages.canPost?`<form class="bulletin-compose" data-bulletin-form="message"><label class="sr-only" for="bulletin-message-body">留言</label><textarea id="bulletin-message-body" name="body" maxlength="600" rows="3" placeholder="写下你的留言…" required>${e(draft)}</textarea><div><small>以 ${e(actor.name||'本人')} 的身份发布</small><button type="submit" class="erp-button erp-primary" ${busy?'disabled':''}>发布留言</button></div></form>`:''}${renderBoardMessages(messages)}`;
    pauseVideo();
    dialog.innerHTML=`<div class="bulletin-shell"><header class="bulletin-header"><div class="bulletin-brand"><img src="./brand-mark.svg" width="25" height="25" alt="莱森购"><strong>信息公开栏</strong></div><div><button type="button" class="bulletin-icon" data-bulletin-action="fullscreen" aria-label="${expanded?'退出大屏':'大屏展示'}" aria-pressed="${expanded}">${icon('fullscreen')}</button><button type="button" class="bulletin-icon" data-bulletin-action="close" aria-label="返回办公室">${icon('close')}</button></div></header><nav class="bulletin-tabs" aria-label="公开栏内容">${tabs.map(([id,label,symbol])=>`<button type="button" data-bulletin-tab="${id}" ${id===section?'aria-current="page"':''}>${icon(symbol)}${label}</button>`).join('')}</nav><main class="bulletin-content" aria-label="${e(title)}">${error?`<div class="bulletin-error" role="alert">${e(error)}<button type="button" data-bulletin-action="retry">重试</button></div>`:''}${content}</main></div>`;lockControls();updateExpanded(expanded);restoreView(savedView);
  }
  function captureDrafts(){
    for(const form of dialog.querySelectorAll('[data-bulletin-form]')){
      const kind=form.dataset.bulletinForm,values=Object.fromEntries(Array.from(form.elements||[]).filter(field=>field.name).map(field=>[field.name,field.value]));
      if(kind==='message'&&typeof values.body==='string')draft=values.body;
      if(kind==='training')trainingDraft={...trainingDraft,...values};
      if(kind==='video')videoDraft={...(videoDraft||{}),...values};
    }
    const details=dialog.querySelector('.bulletin-video-settings');if(details)videoSettingsOpen=details.open;
  }
  function pauseVideo(){try{video()?.pause?.();}catch{/* A failed media decoder must not interrupt navigation. */}}
  function lockControls(){for(const control of dialog.querySelectorAll('form input,form select,form textarea,form button,[data-bulletin-action="delete-message"],[data-bulletin-action="more-messages"]'))control.disabled=busy;dialog.setAttribute('aria-busy',String(busy));}
  function setBusy(value){busy=value;lockControls();}
  const current=ticket=>!destroyed&&ticket===epoch;
  function operationKey(kind,payload){const signature=JSON.stringify([kind,payload]);if(!mutationKeys.has(signature))mutationKeys.set(signature,key());return{signature,id:mutationKeys.get(signature)};}
  async function refresh({force=false}={}){
    if(destroyed)return null;
    if(loading){const value=await loading;return force&&!destroyed?refresh():value;}
    const ticket=epoch;const job=(async()=>{try{const response=await request('/api/erp/bulletin');if(!current(ticket))return null;board=response.board||{};error='';if(dialog.open)render();return board;}catch(err){if(current(ticket)){error=err?.message||'读取失败';if(dialog.open)render();}return null;}})();loading=job;
    try{return await job;}finally{if(loading===job)loading=null;}
  }
  function hidePreview(expectedSection){if(typeof expectedSection==='string'&&expectedSection!==previewSection)return;previewTicket++;previewSection=null;previewAnchor=null;previewElement.hidden=true;previewElement.innerHTML='';}
  function positionPreview(){
    if(!previewAnchor||!previewElement.style)return;
    const rect=chrome.getBoundingClientRect?.()||{left:0,top:0,width:globalThis.innerWidth||1440,height:globalThis.innerHeight||900};
    const width=chrome.clientWidth||rect.width||1440,height=chrome.clientHeight||rect.height||900,sx=width/(rect.width||width),sy=height/(rect.height||height);
    const x=(previewAnchor.x-rect.left)*sx,y=(previewAnchor.y-rect.top)*sy,pw=previewElement.offsetWidth||Math.min(316,width-24),ph=previewElement.offsetHeight||210;
    const left=Math.min(Math.max(12,x-pw/2),Math.max(12,width-pw-12));
    // Stay next to the selected panel. Flip below it only when the top edge has
    // insufficient room; no corner dock, timer or unsolicited surface exists.
    const above=y-ph-12,top=above>=12?above:Math.min(y+20,Math.max(12,height-ph-12));
    Object.assign(previewElement.style,{left:`${left}px`,top:`${top}px`});
    previewElement.dataset.placement=above>=12?'above':'below';
  }
  function paintPreview(content,{pending=false,failed=false}={}){
    const item=bulletinSection(previewSection);if(!item)return;
    previewElement.innerHTML=`<div class="bulletin-preview-heading"><span>${icon(item.symbol)}<strong>${e(item.title)}</strong></span>${icon('arrow')}</div><div class="bulletin-preview-content">${content}</div>`;
    previewElement.dataset.section=item.id;previewElement.setAttribute('aria-busy',String(pending));previewElement.dataset.failed=String(failed);previewElement.hidden=false;positionPreview();
  }
  async function preview(next,anchor){
    if(destroyed||doc.hidden||dialog.open||isBlocked()||!bulletinSection(next)||!Number.isFinite(anchor?.x)||!Number.isFinite(anchor?.y))return;
    const ticket=++previewTicket;previewSection=next;previewAnchor={x:anchor.x,y:anchor.y};
    paintPreview('<p class="bulletin-preview-empty">正在读取…</p>',{pending:true});
    const source=await refresh();
    if(destroyed||ticket!==previewTicket||previewSection!==next||doc.hidden||dialog.open||isBlocked())return;
    if(!source){paintPreview('<p class="bulletin-preview-empty">暂时无法读取</p>',{failed:true});return;}
    paintPreview(renderBoardPreview(next,source,getSnapshot()));
  }
  async function open(next='dashboard',options={}){
    if(destroyed)return;surfaceGeneration++;captureDrafts();hidePreview();if(!dialog.open)previousFocus=doc.activeElement;section=tabs.some(t=>t[0]===next)?next:'dashboard';manage=false;error='';updateExpanded(options.expanded===true);render();
    if(!dialog.open)try{dialog.showModal();surfaceOpen=true;}catch(err){if(!destroyed)onError(err?.message||'公开栏暂时无法打开');return;}await refresh();
  }
  function updateExpanded(value){
    expanded=!!value;dialog.dataset.expanded=String(expanded);
    const control=dialog.querySelector('[data-bulletin-action="fullscreen"]');if(control){control.setAttribute('aria-label',expanded?'退出大屏':'大屏展示');control.setAttribute('title',expanded?'退出大屏':'大屏展示');control.setAttribute('aria-pressed',String(expanded));}
  }
  async function exitNative(){try{if(doc.fullscreenElement===dialog)await doc.exitFullscreen?.();}catch{/* The app-sized layout can always be closed independently. */}}
  function fullscreenChanged(){
    if(destroyed)return;
    if(doc.fullscreenElement===dialog){if(expanded)nativeFullscreen=true;else void exitNative();}
    else if(nativeFullscreen){nativeFullscreen=false;updateExpanded(false);}
  }
  async function toggleExpanded(){
    captureDrafts();const ticket=++fullscreenTicket;
    if(expanded||doc.fullscreenElement===dialog){updateExpanded(false);await exitNative();if(!destroyed&&ticket===fullscreenTicket){nativeFullscreen=doc.fullscreenElement===dialog;if(nativeFullscreen)updateExpanded(true);}return;}
    // Application expansion works in embedded browsers and on displays whose
    // policy rejects the optional native request. It never replaces the form.
    updateExpanded(true);
    try{await dialog.requestFullscreen?.();}catch{/* Keep the application presentation fully usable. */}
    if(destroyed||ticket!==fullscreenTicket||!expanded){await exitNative();return;}
    nativeFullscreen=doc.fullscreenElement===dialog;
  }
  function didClose(){
    if(destroyed||dialog.open||!surfaceOpen)return;
    surfaceOpen=false;surfaceGeneration++;captureDrafts();pauseVideo();fullscreenTicket++;nativeFullscreen=false;updateExpanded(false);void exitNative();manage=false;
    const focus=previousFocus;previousFocus=null;focus?.focus?.();
    try{const result=onClose();result?.catch?.(()=>{});}catch{}
  }
  async function close(){
    if(destroyed||!dialog.open)return;const ticket=surfaceGeneration;
    captureDrafts();pauseVideo();fullscreenTicket++;nativeFullscreen=false;updateExpanded(false);await exitNative();
    if(destroyed||ticket!==surfaceGeneration||!dialog.open)return;dialog.close();didClose();
  }
  async function click(event){
    const target=event.target.closest('[data-bulletin-action],[data-bulletin-tab]');if(!target||destroyed)return;const ticket=epoch;
    try{
      if(target.dataset.bulletinTab){if(!tabs.some(tab=>tab[0]===target.dataset.bulletinTab))return;captureDrafts();section=target.dataset.bulletinTab;manage=false;error='';render();return;}
      switch(target.dataset.bulletinAction){
        case 'close':await close();break;
        case 'fullscreen':await toggleExpanded();break;
        case 'retry':await refresh();break;
        case 'notices':await close();if(current(ticket))onOpenNotices();break;
        case 'manage-training':{
          if(busy)return;captureDrafts();if(manage){manage=false;render();break;}
          if(!people.length){setBusy(true);const r=await request('/api/erp/users');if(!current(ticket))return;people=list(r.users||r.employees);setBusy(false);}
          if(dialog.open&&section==='training'){manage=true;render();}break;
        }
        case 'delete-message':{
          if(busy||!board?.messages)return;const item=list(board.messages.items).find(item=>item.id===target.dataset.id);if(!item?.canDelete)return;
          const payload={expectedVersion:Number(target.dataset.version)},operation=operationKey('delete:'+target.dataset.id,payload);setBusy(true);
          await request(`/api/erp/bulletin/messages/${encodeURIComponent(target.dataset.id)}/delete`,'POST',{_requestId:operation.id,...payload});if(!current(ticket))return;mutationKeys.delete(operation.signature);await refresh({force:true});if(current(ticket))setBusy(false);break;
        }
        case 'more-messages':{
          if(busy||!board?.messages?.hasMore)return;const source=board;setBusy(true);const r=await request('/api/erp/bulletin/messages?before='+encodeURIComponent(source.messages.nextCursor||''));if(!current(ticket))return;
          if(board===source){const seen=new Set(),items=[...list(source.messages.items),...list(r.messages?.items)].filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});board.messages={...r.messages,items};}setBusy(false);if(dialog.open)render();break;
        }
      }
    }catch(err){if(!current(ticket))return;setBusy(false);error=err?.message||'操作未完成';if(dialog.open)render();else onError(error);}
  }
  async function submit(event){
    const form=event.target.closest('[data-bulletin-form]');if(!form)return;event.preventDefault();if(busy||destroyed)return;const kind=form.dataset.bulletinForm;if(!['message','video','training'].includes(kind))return;
    const values=Object.fromEntries(new FormData(form)),ticket=epoch;captureDrafts();setBusy(true);error='';
    try{
      let path,payload;
      if(kind==='message'){draft=String(values.body||'');path='/api/erp/bulletin/messages';payload={body:draft};}
      if(kind==='video'){path='/api/erp/bulletin/video';payload={src:String(values.src||''),title:String(values.title||''),expectedVersion:board?.video?.version||0};}
      if(kind==='training'){const previous=list(board?.training?.entries).find(r=>r.employeeId===values.employeeId&&r.periodStart===values.periodStart&&r.periodEnd===values.periodEnd);path='/api/erp/bulletin/training';payload={entries:[{...values,completedCount:Number(values.completedCount),accuracy:Number(values.accuracy),expectedVersion:previous?.version||0}]};}
      const operation=operationKey(kind,payload);await request(path,'POST',{_requestId:operation.id,...payload});if(!current(ticket))return;mutationKeys.delete(operation.signature);
      if(kind==='message'){draft='';const field=dialog.querySelector('textarea[name="body"]');if(field)field.value='';}
      if(kind==='video')videoDraft=null;
      if(kind==='training'){manage=false;trainingDraft={};}
      await refresh({force:true});if(current(ticket))setBusy(false);
    }catch(err){if(!current(ticket))return;setBusy(false);error=err?.message||'操作未完成';if(dialog.open)render();}
  }
  function input(event){if(busy||destroyed)return;if(event.target.name==='body'){draft=event.target.value;}else captureDrafts();}
  function visibility(){if(doc.hidden){hidePreview();pauseVideo();}}
  function focus(){if(isBlocked())hidePreview();}
  function cancel(event){event.preventDefault();void close();}
  dialog.addEventListener('click',click);dialog.addEventListener('submit',submit);dialog.addEventListener('input',input);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',didClose);doc.addEventListener('visibilitychange',visibility);doc.addEventListener('focusin',focus);doc.addEventListener('fullscreenchange',fullscreenChanged);
  return{open,close,refresh,preview,hidePreview,get isOpen(){return dialog.open;},destroy(){if(destroyed)return;destroyed=true;epoch++;fullscreenTicket++;nativeFullscreen=false;updateExpanded(false);void exitNative();hidePreview();pauseVideo();dialog.removeEventListener('click',click);dialog.removeEventListener('submit',submit);dialog.removeEventListener('input',input);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',didClose);doc.removeEventListener('visibilitychange',visibility);doc.removeEventListener('focusin',focus);doc.removeEventListener('fullscreenchange',fullscreenChanged);dialog.close();dialog.innerHTML='';dialog.remove();previewElement.remove();board=null;people=[];draft='';trainingDraft={};videoDraft=null;mutationKeys.clear();}};
}
