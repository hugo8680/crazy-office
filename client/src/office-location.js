import {OFFICE_SEATS,departmentById,canonicalDepartmentId} from './organization.mjs';
import {escapeHtml as e} from './erp-ui.mjs';

// Every action is checked again by the server. This surface keeps an old
// reservation response from closing a newer selection or a different session.
export function mountOfficeLocation({container,presence,scene,onWork=()=>{},onError=()=>{}}={}){
 const doc=container.ownerDocument,dialog=doc.createElement('dialog');dialog.className='office-location-dialog';dialog.setAttribute('aria-label','办公位置');container.append(dialog);
 let destroyed=false,busy=false,selectedSeat=null,previousFocus=null,epoch=0;
 function lock(){for(const button of dialog.querySelectorAll('[data-location]'))if(!['close','work'].includes(button.dataset.location))button.disabled=busy||button.dataset.unavailable==='true';dialog.setAttribute('aria-busy',String(busy));}
 function close(){epoch++;if(dialog.open)dialog.close();previousFocus?.focus?.();selectedSeat=null;}
 function show(seatId){
  if(destroyed)return false;const me=presence.self;if(!me){onError('请重新登录。');return false;}const seat=OFFICE_SEATS.find(s=>s.id===seatId);if(seatId&&!seat)return false;
  epoch++;selectedSeat=seatId||null;const occupied=seat?(presence.people||[]).find(p=>p.posture==='seated'&&p.seatId===seat.id&&p.id!==me.id):null;
  if(!dialog.open)previousFocus=doc.activeElement;
  const ownPost=OFFICE_SEATS.find(post=>post.id===me.appearanceKey),allowed=new Set(OFFICE_SEATS.filter(post=>ownPost&&post.personId===ownPost.personId).map(post=>post.departmentId));const department=canonicalDepartmentId(me.department);if(department)allowed.add(department);
  const outside=seat&&allowed.size>0&&!allowed.has(seat.departmentId),already=seat&&me.posture==='seated'&&me.seatId===seat.id,unavailable=!!occupied||!!outside;
  const title=seat?'选择工位':me.name||'我的位置',subtitle=departmentById(seat?.departmentId||me.nodeId)?.name||'公共休息区',status=occupied?`${occupied.name} 正在使用`:outside?'请在本部门选择工位。':seat?(already?'已在此工位':'该位置空闲'):me.posture==='seated'?'已入座':'可自由走动';
  dialog.innerHTML=`<div class="office-location-head"><span>${e(subtitle)}</span><button type="button" data-location="close" aria-label="关闭">×</button></div><h2>${e(title)}</h2><p class="${unavailable?'office-location-occupied':''}">${e(status)}</p><div class="office-location-actions">${seat&&!already?`<button type="button" class="erp-button erp-primary" data-location="sit-seat" data-unavailable="${unavailable}" ${unavailable||busy?'disabled':''}>坐在这里</button>`:me.posture==='seated'?'<button type="button" class="erp-button erp-primary" data-location="stand">起身</button>':'<button type="button" class="erp-button erp-primary" data-location="sit-point">坐下</button>'}${!seat?'<button type="button" class="erp-button" data-location="work">我的工作</button>':''}</div>`;
  lock();if(!dialog.open)try{dialog.showModal();}catch(error){onError(error?.message||'办公位置暂时无法打开');return false;}return true;
 }
 async function click(event){
  const button=event.target.closest('[data-location]');if(!button||destroyed)return;const action=button.dataset.location;
  if(action==='close'){close();return;}if(action==='work'){close();onWork();return;}if(busy||button.disabled||!['sit-seat','stand','sit-point'].includes(action))return;
  const ticket=epoch,seatId=selectedSeat;busy=true;lock();try{
   let ok=false;
   if(action==='sit-seat')ok=await presence.sit(seatId);
   if(action==='stand')ok=await presence.stand();
   if(action==='sit-point'){
    const me=presence.self,point=scene.getPresenceState?.()?.positions?.[me?.id]||{x:me?.x,y:me?.y};
    if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new Error('位置尚未就绪，请重试。');
    ok=await presence.sitAt({x:point.x,y:point.y});
   }
   if(destroyed||ticket!==epoch)return;if(ok)close();else show(seatId);
  }catch(error){if(!destroyed&&ticket===epoch)onError(error?.message||'操作未完成，请重试。');}
  finally{busy=false;if(!destroyed)lock();}
 }
 function cancel(event){event.preventDefault();close();}dialog.addEventListener('click',click);dialog.addEventListener('cancel',cancel);
 return{openSelf:()=>show(),openSeat:show,close,get isOpen(){return dialog.open;},destroy(){if(destroyed)return;destroyed=true;epoch++;dialog.close();dialog.innerHTML='';dialog.removeEventListener('click',click);dialog.removeEventListener('cancel',cancel);dialog.remove();selectedSeat=null;previousFocus=null;}};
}
