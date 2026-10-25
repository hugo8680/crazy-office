// One owner for office shortcuts. Map input never borrows keystrokes from a
// form, a modal, another tab or the operating system's keyboard shortcuts.
const directions=Object.freeze({KeyW:[0,-1],ArrowUp:[0,-1],KeyS:[0,1],ArrowDown:[0,1],KeyA:[-1,0],ArrowLeft:[-1,0],KeyD:[1,0],ArrowRight:[1,0]});
const textSelector='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
export function officeInputIsEditing(target){return !!(target?.isContentEditable||target?.closest?.(textSelector));}
const codeFor=event=>directions[event.code]?event.code:({w:'KeyW',a:'KeyA',s:'KeyS',d:'KeyD'})[event.key?.toLowerCase()]||event.key;

export function mountOfficeInput({document:doc=globalThis.document,window:win=globalThis.window,isEnabled=()=>true,isBlocked=()=>false,onStart=()=>true,onStep=()=>{},onStop=()=>{},onEscape=()=>false,onHome=()=>false,requestFrame=callback=>win?.requestAnimationFrame?.(callback),cancelFrame=id=>win?.cancelAnimationFrame?.(id)}={}){
 let disposed=false,active=false,frame=null,lastTime=null;
 const pressed=new Set(),suppressed=new Set(),listeners=[];
 const listen=(target,type,handler,options)=>{target?.addEventListener?.(type,handler,options);listeners.push(()=>target?.removeEventListener?.(type,handler,options));};
 const blocked=target=>disposed||doc?.hidden||doc?.hasFocus?.()===false||!isEnabled()||isBlocked()||!!doc?.querySelector?.('dialog[open]')||officeInputIsEditing(target)||officeInputIsEditing(doc?.activeElement);
 const consume=event=>{event.preventDefault?.();event.stopImmediatePropagation?.();};
 function stop(reason='release'){
  if(reason!=='release')for(const key of pressed)suppressed.add(key);
  pressed.clear();if(frame!==null)cancelFrame(frame);frame=null;lastTime=null;
  if(!active)return false;active=false;onStop({reason});return true;
 }
 function tick(time){
  frame=null;if(!active)return;
  if(blocked()){stop('blocked');return;}
  let x=0,y=0;for(const key of pressed){const direction=directions[key];x+=direction[0];y+=direction[1];}
  const size=Math.hypot(x,y),milliseconds=lastTime===null?16:Math.max(0,Math.min(50,time-lastTime));lastTime=time;
  if(size)onStep({x:x/size,y:y/size},milliseconds);
  if(active)frame=requestFrame(tick)??null;
 }
 function keydown(event){
  if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
  if(disposed||doc?.hidden||doc?.hasFocus?.()===false){stop('inactive');return;}
  const code=codeFor(event),movement=!!directions[code];
  if(event.ctrlKey||event.metaKey||event.altKey){if(movement)stop('shortcut');return;}
  if(event.key==='Escape'){
   if(event.repeat){consume(event);return;}
   // Native modal cancellation and the business pane each own their topmost
   // layer. A single Escape must never also dismiss the map underneath it.
   if(doc?.querySelector?.('dialog[open]')){stop('modal');return;}
   if(onEscape()===true){stop('escape');consume(event);}return;
  }
  if(blocked(event.target)){if(active)stop('blocked');return;}
  if(event.key==='Home'){if(onHome()===true){stop('home');consume(event);}return;}
  if(!movement)return;
  if(suppressed.has(code)){if(event.repeat){consume(event);return;}suppressed.delete(code);}
  consume(event);pressed.add(code);
  if(!active){if(onStart()===false){suppressed.add(code);pressed.clear();return;}active=true;lastTime=null;frame=requestFrame(tick)??null;}
 }
 function keyup(event){const key=codeFor(event);if(!directions[key])return;pressed.delete(key);suppressed.delete(key);if(active&&!pressed.size)stop('release');}
 listen(doc,'keydown',keydown,true);listen(doc,'keyup',keyup,true);
 listen(doc,'focusin',event=>{if(blocked(event.target))stop('focus');},true);
 listen(doc,'compositionstart',()=>stop('composition'));
 listen(doc,'visibilitychange',()=>{if(doc?.hidden)stop('hidden');});
 listen(win,'blur',()=>stop('blur'));listen(win,'pagehide',()=>stop('pagehide'));
 return{stop,get active(){return active;},destroy(){if(disposed)return;stop('destroy');disposed=true;for(const remove of listeners)remove();}};
}
