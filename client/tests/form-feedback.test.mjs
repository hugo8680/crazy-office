import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldValidationMessage,mountFormFeedback} from '../src/form-feedback.mjs';

// The browser owns constraint validation; this adapter exercises the delegated
// feedback lifecycle without reimplementing HTML validity algorithms.
function dom(){
  class Node{
    constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.attrs=new Map();this.children=[];this.parentElement=null;this.dataset={};this.textContent='';this.focusCalls=[];this.scrollCalls=[];this.visible=true;}
    get isConnected(){return this===doc||!!this.parentElement?.isConnected;}
    get id(){return this.getAttribute('id')||'';}set id(value){this.setAttribute('id',value);}
    get className(){return this.getAttribute('class')||'';}set className(value){this.setAttribute('class',value);}
    setAttribute(name,value){this.attrs.set(name,String(value));}
    getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null;}
    removeAttribute(name){this.attrs.delete(name);}
    append(...children){for(const node of children){node.remove();node.parentElement=this;this.children.push(node);}}
    remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}}
    matches(selector){return selector.split(',').some(part=>{const s=part.trim();if(s.startsWith('.'))return this.className.split(/\s+/).includes(s.slice(1));if(s.startsWith('['))return this.attrs.has(s.slice(1,-1));return this.tagName===s.toUpperCase();});}
    closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
    querySelectorAll(selector){return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    insertAdjacentElement(position,node){assert.equal(position,'afterend');assert.ok(this.parentElement);node.remove();const parent=this.parentElement;node.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}
    getClientRects(){return this.visible?[{}]:[];}
    focus(options){this.focusCalls.push(options);}
    scrollIntoView(options){this.scrollCalls.push(options);}
  }
  const doc=new Node('document',null);doc.ownerDocument=doc;const listeners=new Map(),scheduled=[];
  doc.createElement=tag=>new Node(tag,doc);
  doc.getElementById=id=>doc.querySelectorAll('[id]').find(node=>node.id===id)||null;
  doc.addEventListener=(type,handler,capture)=>{assert.equal(capture,true);listeners.set(type,handler);};
  doc.removeEventListener=(type,handler,capture)=>{assert.equal(capture,true);assert.equal(listeners.get(type),handler);listeners.delete(type);};
  const add=(tag,parent=doc)=>{const node=doc.createElement(tag);parent.append(node);return node;};
  const dialog=add('dialog'),form=add('form',dialog);
  const field=({tag='input',parent=form,label='项目名称',validity={valueMissing:true,valid:false},...props}={})=>{const node=add(tag,parent);Object.assign(node,{type:'text',form,willValidate:true,validity},props);if(label!==null)node.setAttribute('aria-label',label);return node;};
  const emit=(type,target)=>{const event={type,target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};listeners.get(type)?.(event);return event;};
  const ui=mountFormFeedback({root:doc,schedule:callback=>scheduled.push(callback)});
  return {doc,dialog,form,field,add,emit,ui,listeners,flush(){while(scheduled.length)scheduled.shift()();},hints:()=>doc.querySelectorAll('.office-field-feedback')};
}

test('constraint feedback names missing fields and gives concise Chinese format and range guidance',()=>{
  const field=(validity,props={})=>({tagName:'INPUT',type:'text',validity,getAttribute:()=> '项目名称',...props});
  const cases=[
    [field({valueMissing:true}),'请填写项目名称'],
    [field({valueMissing:true},{tagName:'SELECT'}),'请选择项目名称'],
    [field({valueMissing:true},{type:'checkbox'}),'请选择后再继续'],
    [field({valueMissing:true},{type:'radio'}),'请选择后再继续'],
    [field({typeMismatch:true},{type:'email'}),'请填写有效的邮箱地址'],
    [field({typeMismatch:true},{type:'url'}),'请填写完整的网址'],
    [field({tooShort:true},{minLength:12}),'至少填写 12 个字符'],
    [field({tooLong:true},{maxLength:80}),'最多填写 80 个字符'],
    [field({rangeUnderflow:true},{min:'0'}),'不能小于 0'],
    [field({rangeOverflow:true},{max:'100'}),'不能大于 100'],
    [field({stepMismatch:true},{step:'1'}),'请填写整数'],
    [field({stepMismatch:true},{step:'0.25'}),'请按要求填写数值'],
    [field({badInput:true}),'请填写有效的数值'],
    [field({patternMismatch:true},{title:'请填写六位编号'}),'请填写六位编号'],
    [field({customError:true},{validationMessage:'结束日期不能早于开始日期'}),'结束日期不能早于开始日期'],
    [field({},{}),'请检查填写内容'],
    [field({valueMissing:true},{getAttribute:()=> '很长的产品名称后面还有许多数量及单位信息'}),'请填写此项'],
  ];
  for(const [input,expected]of cases)assert.equal(fieldValidationMessage(input),expected);
});

test('invalid native controls receive one inline hint, preserve descriptions and focus the first invalid field once',()=>{
  const h=dom(),wrapper=h.add('span',h.form);wrapper.className='session-input';const first=h.field({parent:wrapper}),second=h.field({label:'密码'});
  first.setAttribute('aria-describedby','existing-help');first.setAttribute('aria-invalid','false');
  const firstEvent=h.emit('invalid',first),secondEvent=h.emit('invalid',second);h.emit('invalid',first);
  assert.equal(firstEvent.defaultPrevented,true);assert.equal(secondEvent.defaultPrevented,true);assert.equal(first.validity.valueMissing,true,'native constraints are retained');assert.equal(h.hints().length,2);
  const hint=h.hints()[0];assert.equal(h.form.children[1],hint,'feedback follows the input wrapper rather than entering the icon layout');assert.equal(hint.children[0].textContent,'请填写项目名称');assert.equal(hint.getAttribute('role'),'status');assert.equal(first.getAttribute('aria-describedby'),'existing-help '+hint.id);assert.equal(first.getAttribute('aria-invalid'),'true');
  h.flush();assert.deepEqual(first.focusCalls,[{preventScroll:true}]);assert.equal(second.focusCalls.length,0);assert.deepEqual(first.scrollCalls,[{block:'nearest',inline:'nearest'}]);
  first.validity={valid:true};h.emit('input',first);assert.equal(h.hints().length,1);assert.equal(first.getAttribute('aria-describedby'),'existing-help');assert.equal(first.getAttribute('aria-invalid'),'false');assert.equal(first.getAttribute('data-office-invalid'),null);
  h.ui.destroy();assert.equal(h.hints().length,0);assert.equal(h.listeners.size,0);
});

test('delegation covers forms rendered later, updates invalid guidance and ignores controls outside validation',()=>{
  const h=dom(),later=h.add('form'),input=h.field({parent:later,label:'完成量',form:later,validity:{rangeUnderflow:true,valid:false},min:'0'});
  h.emit('invalid',input);const hint=h.hints()[0];assert.equal(hint.children[0].textContent,'不能小于 0');
  input.validity={stepMismatch:true,valid:false};input.step='1';h.emit('change',input);assert.equal(h.hints().length,1);assert.equal(h.hints()[0],hint);assert.equal(hint.children[0].textContent,'请填写整数');
  const disabled=h.field({willValidate:false}),outside=h.field({form:null}),button=h.add('button',later);assert.equal(h.emit('invalid',disabled).defaultPrevented,false);assert.equal(h.emit('invalid',outside).defaultPrevented,false);assert.equal(h.emit('invalid',button).defaultPrevented,false);assert.equal(h.hints().length,1);
  input.validity={valid:true};h.emit('change',input);assert.equal(h.hints().length,0);assert.equal(input.getAttribute('aria-describedby'),null);assert.equal(input.getAttribute('aria-invalid'),null);h.ui.destroy();
});

test('reset, submit, session navigation and dialog closure clear only feedback in the affected surface',()=>{
  const h=dom(),otherForm=h.add('form'),first=h.field(),outside=h.field({parent:otherForm,form:otherForm});
  const invalidate=()=>{h.emit('invalid',first);h.emit('invalid',outside);};
  invalidate();h.emit('reset',h.form);assert.equal(h.hints().length,1);assert.equal(outside.getAttribute('aria-invalid'),'true');
  invalidate();h.emit('submit',h.form);assert.equal(first.getAttribute('aria-invalid'),null);assert.equal(h.hints().length,1);
  const action=h.add('button',h.dialog),child=h.add('span',action);action.setAttribute('data-session-action','register');action.dataset.sessionAction='register';
  invalidate();h.emit('click',child);assert.equal(first.getAttribute('aria-invalid'),null);assert.equal(h.hints().length,1);
  invalidate();h.emit('close',h.dialog);assert.equal(first.getAttribute('aria-invalid'),null);assert.equal(h.hints().length,1);
  h.ui.clear();assert.equal(h.hints().length,0);h.ui.destroy();
});

test('queued focus does not touch detached, hidden or destroyed surfaces',()=>{
  for(const state of ['detached','hidden','destroyed']){
    const h=dom(),input=h.field();h.emit('invalid',input);
    if(state==='detached')h.dialog.remove();else if(state==='hidden')input.visible=false;else h.ui.destroy();
    h.flush();assert.equal(input.focusCalls.length,0,state);if(state!=='destroyed')h.ui.destroy();
  }
});
