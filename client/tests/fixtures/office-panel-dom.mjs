// Minimal form/dialog DOM adapter. Production rendering, state, request ordering
// and mutation handlers run unchanged; this adapter never invents results.
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const attrs=source=>Object.fromEntries([...source.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
const dataset=attributes=>Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase()),value]));
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
export const flush=async()=>{for(let index=0;index<4;index++)await new Promise(resolve=>setImmediate(resolve));};
export function panelDom(){
 const listeners=new Map(),timers=new Map();let sequence=0;
 const doc={hidden:false,fullscreenElement:null,activeElement:{focuses:0,focus(){this.focuses++;}},createElement:tag=>new Element(tag),addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);},async exitFullscreen(){doc.fullscreenElement=null;}};
 class Element{
  constructor(tag='div'){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.attrs={};this.style={};this.handlers=new Map();this.open=false;this.hidden=false;this._html='';this.forms=[];this.buttons=[];this.paused=0;this.removed=false;this.content=null;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}setAttribute(key,value){this.attrs[key]=value;}getAttribute(key){return this.attrs[key];}addEventListener(type,fn){this.handlers.set(type,fn);}removeEventListener(type){this.handlers.delete(type);}remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}showModal(){this.open=true;}close(){this.open=false;}async requestFullscreen(){doc.fullscreenElement=this;}focus(){doc.activeElement=this;}
  set innerHTML(value){
   const decorate=(node,tag)=>Object.assign(node,{tagName:tag.toUpperCase(),owner:this,scrollTop:0,scrollLeft:0,focus(options){doc.activeElement=this;this.focusOptions=options;},setSelectionRange(start,end,direction='none'){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}});
   this._html=value;this.forms=[];this.buttons=[...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m=>{const a=attrs(m[1]);return{...a,dataset:dataset(a),disabled:/\sdisabled(?:\s|$)/.test(m[1]),textContent:decode(m[2].replace(/<[^>]+>/g,'')),attrs:{...a},setAttribute(key,value){this.attrs[key]=value;},getAttribute(key){return this.attrs[key];},closest(){return this;}};});
   for(const match of value.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)){
    const elements=[];
    for(const m of match[2].matchAll(/<input\b([^>]*)>/g)){const a=attrs(m[1]);elements.push({...a,value:a.value||'',disabled:false});}
    for(const m of match[2].matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)){const a=attrs(m[1]);elements.push({...a,value:decode(m[2]),disabled:false});}
    for(const m of match[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)){const a=attrs(m[1]),options=[...m[2].matchAll(/<option\b([^>]*)>/g)],selected=options.find(o=>/\bselected\b/.test(o[1]))||options[0];elements.push({...a,value:selected?attrs(selected[1]).value||'':'',disabled:false});}
    const form={dataset:dataset(attrs(match[1])),elements,closest(){return this;}};
    for(const field of elements){field.form=form;decorate(field,match[2].includes(`<textarea`)&&field.name==='body'?'textarea':match[2].includes(`<select name="${field.name}"`)?'select':'input');}
    this.forms.push(form);
   }
   for(const button of this.buttons){decorate(button,'button');if(button.type==='submit')button.form=this.forms.find(form=>this._html.includes(`data-bulletin-form="${form.dataset.bulletinForm}"`));}
   this.content=/<main[^>]*class="bulletin-content"/.test(value)?{scrollTop:0,scrollLeft:0}:null;
   this.video=/<video\b/.test(value)?decorate({pause:()=>{this.paused++;}},'video'):null;
   const details=value.match(/<details\b([^>]*)>/);this.details=details?{open:/\bopen\b/.test(details[1]),summary:decorate({},'summary')}:null;
  }
  get innerHTML(){return this._html;}
  contains(node){return node===this||node?.owner===this||this.children.some(child=>child.contains?.(node));}
  querySelector(selector){if(selector==='.bulletin-content')return this.content;const action=selector.match(/^\[data-bulletin-action="([^"]+)"\]$/)?.[1];if(action)return this.buttons.find(button=>button.dataset.bulletinAction===action)||null;if(selector==='video')return this.video;if(selector==='.bulletin-video-settings')return this.details;const name=selector.match(/\[name="([^"]+)"\]/)?.[1];if(name)return this.forms.flatMap(f=>f.elements).find(field=>field.name===name)||null;return null;}
  querySelectorAll(selector){if(selector==='button,input,select,textarea,summary,video')return [...this.buttons,...this.forms.flatMap(form=>form.elements),this.details?.summary,this.video].filter(Boolean);if(selector==='[data-bulletin-form]')return this.forms;if(selector==='[data-location]')return this.buttons.filter(button=>button.dataset.location);if(selector.startsWith('form input'))return [...this.forms.flatMap(form=>form.elements),...this.buttons.filter(button=>button.type==='submit'||['delete-message','more-messages'].includes(button.dataset.bulletinAction))];return [];}
  async emit(type,target){let prevented=false;await this.handlers.get(type)?.({target,preventDefault(){prevented=true;}});return prevented;}
 }
 const container=new Element(),chrome=new Element(),savedFormData=globalThis.FormData,savedMedia=globalThis.matchMedia;
 globalThis.FormData=class{constructor(form){this.values=form.elements.filter(field=>!field.disabled).map(field=>[field.name,field.value]);}[Symbol.iterator](){return this.values[Symbol.iterator]();}};globalThis.matchMedia=()=>({matches:false});
 return{document:doc,container,chrome,listeners,timers,setTimer(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimer(id){timers.delete(id);},async timer({minimum=0,maximum=Infinity}={}){const entry=[...timers].find(([,timer])=>timer.delay>=minimum&&timer.delay<=maximum);if(!entry)throw Error('Expected a scheduled UI timer');timers.delete(entry[0]);await entry[1].fn();},event(type){listeners.get(type)?.();},restore(){globalThis.FormData=savedFormData;if(savedMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=savedMedia;}};
}
