import test from 'node:test';
import assert from 'node:assert/strict';
import {mountOfficePerson} from '../src/office-person.js';
import {setOrganizationOccupants} from '../src/organization-occupants.mjs';
import {panelDom} from './fixtures/office-panel-dom.mjs';

const viewer={authenticated:true,actor:{id:'viewer'}},directory=[{personId:'business-manager',name:'董正旭',username:'dongzhengxu@example.invalid',title:'经理',seatIds:['business_manager_001','channels_manager_001']},{personId:'business-staff',name:'栾伟龙',username:'luanweilong@example.invalid',title:'商务专员',seatIds:['business_staff_001']}];
function harness(){
 const dom=panelDom(),closes=[];let session=viewer,people=[];setOrganizationOccupants(directory);
 const ui=mountOfficePerson({container:dom.container,getSession:()=>session,getPeople:()=>people,onClose:()=>closes.push('close')}),dialog=dom.container.children[0];
 return{...dom,ui,dialog,closes,session(value){session=value;},people(value){people=value;},destroy(){ui.destroy();setOrganizationOccupants([]);dom.restore();}};
}

test('clicking a directory person shows a compact actual colleague card without seat or ERP actions',()=>{
 const h=harness();try{
  assert.equal(h.ui.open('business_manager_001'),true);assert.equal(h.ui.isOpen,true);assert.match(h.dialog.innerHTML,/董正旭/);assert.match(h.dialog.innerHTML,/商务部、渠道部/);assert.match(h.dialog.innerHTML,/dongzhengxu@example.invalid/);assert.match(h.dialog.innerHTML,/离线/);
  assert.doesNotMatch(h.dialog.innerHTML,/选择工位|坐在这里|新建单据|查看进展|发送|交办/);assert.equal(h.dialog.buttons.length,1);
 }finally{h.destroy();}
});

test('a colleague sitting at another person’s home desk cannot impersonate that person’s online status or details',()=>{
 const h=harness();try{
  h.people([{id:'employee-a',name:'董正旭',online:true,appearanceKey:'business_manager_001',seatId:'business_staff_001',posture:'seated',outfitId:'marine'}]);
  h.ui.open('business_staff_001');assert.match(h.dialog.innerHTML,/栾伟龙/);assert.match(h.dialog.innerHTML,/离线/);assert.doesNotMatch(h.dialog.innerHTML,/dongzhengxu@example.invalid/);
  h.ui.open('channels_manager_001');assert.match(h.dialog.innerHTML,/董正旭/);assert.match(h.dialog.innerHTML,/data-online="true"/);assert.match(h.dialog.innerHTML,/#506a88/);
 }finally{h.destroy();}
});

test('online records refresh presence and clothing in place without remounting an unchanged window',()=>{
 const h=harness();try{
  h.ui.open('business_staff_001');const closeButton=h.dialog.buttons[0];h.ui.refresh();assert.equal(h.dialog.buttons[0],closeButton);
  h.people([{id:'employee-b',name:'栾伟龙',online:true,appearanceKey:'business_staff_001',outfitId:'plum'}]);h.ui.refresh();assert.match(h.dialog.innerHTML,/data-online="true"/);assert.match(h.dialog.innerHTML,/#856e8f/);
  h.people([]);h.ui.refresh();assert.match(h.dialog.innerHTML,/data-online="false"/);assert.equal(h.ui.isOpen,true);assert.deepEqual(h.closes,[]);
 }finally{h.destroy();}
});

test('anonymous and fabricated people cannot open private directory cards, and account changes clear an open card',()=>{
 const h=harness();try{
  h.session(null);assert.equal(h.ui.open('business_manager_001'),false);assert.equal(h.dialog.innerHTML,'');
  h.session(viewer);assert.equal(h.ui.open({id:'made-up',name:'伪造同事',username:'fake@example.invalid'}),false);assert.equal(h.ui.open('not-a-seat'),false);
  h.ui.open('business_manager_001');h.session({authenticated:true,actor:{id:'next-viewer'}});h.ui.refresh();assert.equal(h.ui.isOpen,false);assert.equal(h.dialog.innerHTML,'');assert.deepEqual(h.closes,['close']);
 }finally{h.destroy();}
});

test('an online account without a roster post shows safe real presence, without treating a visited desk as identity',()=>{
 const h=harness();try{
  const person={id:'visitor',name:'<img src=x onerror=bad>',online:true,department:'财务部',title:'<script>bad</script>',username:'visitor@example.invalid',seatId:'business_staff_001'};
  h.people([person]);assert.equal(h.ui.open(person),true);assert.match(h.dialog.innerHTML,/&lt;img/);assert.match(h.dialog.innerHTML,/&lt;script/);assert.match(h.dialog.innerHTML,/财务部/);assert.match(h.dialog.innerHTML,/visitor@example.invalid/);assert.doesNotMatch(h.dialog.innerHTML,/<img|<script|栾伟龙/);
  h.people([]);h.ui.refresh();assert.equal(h.ui.isOpen,false);assert.equal(h.dialog.innerHTML,'');
 }finally{h.destroy();}
});

test('close, Escape and native closure each restore the existing context once, while destroy never opens another surface',async()=>{
 const h=harness();try{
  h.ui.open('business_manager_001');await h.dialog.emit('cancel',h.dialog);assert.equal(h.ui.isOpen,false);assert.equal(h.closes.length,1);assert.equal(h.dialog.innerHTML,'');
  h.ui.open('business_staff_001');h.dialog.close();await h.dialog.emit('close',h.dialog);await h.dialog.emit('close',h.dialog);assert.equal(h.closes.length,2);
  h.ui.open('business_manager_001');h.ui.destroy();assert.equal(h.closes.length,2);assert.equal(h.dialog.removed,true);assert.equal(h.dialog.innerHTML,'');
 }finally{h.destroy();}
});
