import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {EMPLOYEE_WARDROBE,employeeAppearance,employeeAppearanceKey} from '../../src/employee-appearance.mjs';
const source=await readFile(new URL('../../src/session-ui.js',import.meta.url),'utf8');
const PASSWORD='employee-password-2026';
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});

// Run the production module with minimal DOM and transport adapters. Only the
// HTTP response and browser surface are fakes; all state/validation is real JS.
export function harness({session=null,fragment='',pathname='/',responder,reducedMotion=true}={}){
  const elements=new Map(),requests=[],timers=new Map(),history=[],redirects=[],events={authenticated:[],signedOut:0,expired:0,changes:[],closed:0,closedWhileOpen:[],located:[]};let timer=0;
  const element=selector=>{
    if(elements.has(selector))return elements.get(selector);
    const node={hidden:false,disabled:false,value:'',textContent:'',dataset:{},attrs:new Map(),listeners:new Map(),focused:0,open:false,isConnected:true,innerHTML:'',
      setAttribute(key,value){this.attrs.set(key,value);},getAttribute(key){return this.attrs.get(key);},focus(){this.focused++;},reportValidity(){return true;},
      addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);},
      querySelector:element,querySelectorAll(){return [...elements.values()].filter(e=>e!==this);},
      showModal(){this.open=true;},close(){this.open=false;},append(){},remove(){this.isConnected=false;}};
    elements.set(selector,node);return node;
  };
  const dialog=element('dialog'),container={append(node){this.child=node;}},documentListeners=new Map();
  const document={body:container,activeElement:element('before-focus'),hidden:false,createElement:element,addEventListener(type,fn){documentListeners.set(type,fn);},removeEventListener(type){documentListeners.delete(type);}};
  const location={hash:fragment,pathname,replace(url){redirects.push(url);},assign(url){redirects.push(url);}};
  const scope={EMPLOYEE_WARDROBE,employeeAppearance,employeeAppearanceKey,URLSearchParams,TextEncoder,AbortController,Date,Promise,document,window:{location,matchMedia:()=>({matches:reducedMotion}),history:{replaceState(_state,_title,url){history.push(url);location.pathname='/';location.hash='';}}},
    setTimeout(fn,delay){const id=++timer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);},
    fetch:async(url,options)=>{requests.push({url,options});return responder?responder(url,options):response({session:session||{authenticated:false}});},
    console:{log(){throw Error('credential log');},error(){throw Error('credential log');}},localStorage:{setItem(){throw Error('credential persistence');}},sessionStorage:{setItem(){throw Error('credential persistence');}}};
  vm.createContext(scope);vm.runInContext(source.replace(/^import .*?;\n/m,'').replace('export function mountSession','function mountSession'),scope,{filename:'session-ui.js'});
  scope.options={container,requestRaw:scope.fetch,onAuthenticated:s=>events.authenticated.push(s),onSignedOut:()=>events.signedOut++,onSessionExpired:()=>events.expired++,onChange:s=>events.changes.push(s),onClose:()=>{events.closed++;events.closedWhileOpen.push(dialog.open);},onLocate:s=>events.located.push(s)};
  const ui=vm.runInContext('mountSession(options)',scope);
  return {ui,dialog,element,events,requests,timers,history,redirects,scope,setResponder(fn){responder=fn;},
    login(username='lin',password=PASSWORD){element('#session-username').value=username;element('#session-password').value=password;return element('#session-login-form').listeners.get('submit')({preventDefault(){}});},
    password(current=PASSWORD,next=PASSWORD+'-new',confirm=next){element('#session-current').value=current;element('#session-new').value=next;element('#session-confirm').value=confirm;return element('#session-password-form').listeners.get('submit')({preventDefault(){}});},
    invitation(password=PASSWORD,confirmation=password){element('#session-invitation-password').value=password;element('#session-invitation-confirm').value=confirmation;return element('#session-invitation-form').listeners.get('submit')({preventDefault(){}});},
    outfit(id){const node=element(`#session-outfit-${id}`);node.dataset.sessionAction='choose-outfit';node.dataset.outfit=id;return dialog.listeners.get('click')({target:{closest:()=>node}});},
    saveOutfit(){return element('#session-appearance-form').listeners.get('submit')({preventDefault(){}});},
    outfitKey(key){let prevented=false;element('#session-appearance-form').listeners.get('keydown')({key,target:{closest:()=>element('#session-outfit-atelier')},preventDefault(){prevented=true;}});return prevented;},
    click(action){const node=element(`[data-session-action="${action}"]`);node.dataset.sessionAction=action;return dialog.listeners.get('click')({target:{closest:()=>node}});},
    escape(){let prevented=false;dialog.listeners.get('cancel')({preventDefault(){prevented=true;}});if(!prevented)dialog.close();return prevented;},
    runTimer(delay){const entry=[...timers.entries()].find(([,value])=>value.delay===delay);if(!entry)throw Error(`No timer for ${delay}`);timers.delete(entry[0]);entry[1].fn();},
    visible(){documentListeners.get('visibilitychange')?.();},
    destroy(){ui.destroy();}};
}

