import test from 'node:test';
import assert from 'node:assert/strict';
import {selectOfficeNameLabels} from '../src/person-labels.mjs';

test('constant small names prefer the current employee and avoid overlapping nearby labels without drawing panels',()=>{
 const labels=[{id:'staff',name:'王明',x:60,y:50,priority:3},{id:'me',name:'张强',x:60,y:50,priority:0},{id:'agent',name:'小张',x:150,y:50,priority:1},{id:'other',name:'李岩',x:151,y:50,priority:3}];const result=selectOfficeNameLabels(labels,{width:250,height:150});assert.deepEqual(result.map(label=>label.id),['me','agent']);assert.ok(result.every(label=>label.box.h===13));
});

test('further apart projected desks reveal more labels while offscreen and duplicate identities stay hidden',()=>{
 const people=Array.from({length:10},(_,i)=>({id:'staff-'+i,name:'aidata'+String(i).padStart(2,'0'),x:20+i*12,y:50,priority:3}));const overview=selectOfficeNameLabels(people,{width:800,height:160}),detail=selectOfficeNameLabels(people.map((p,i)=>({...p,x:45+i*65})),{width:800,height:160});assert.ok(overview.length<detail.length);assert.equal(detail.length,10);assert.equal(selectOfficeNameLabels([{id:'x',name:'员工',x:-20,y:30},{id:'y',name:'员工',x:80,y:-10}],{width:200,height:100}).length,0);assert.equal(selectOfficeNameLabels([{id:'a',name:'张强',x:50,y:30},{id:'a',name:'张强',x:150,y:30}],{width:200,height:100}).length,1);
});

test('ordinary department names remain complete even where a nearby optional label has higher priority',()=>{
 const result=selectOfficeNameLabels([{id:'agent',name:'小张',x:70,y:45,priority:1},{id:'employee',name:'李嘉明',x:70,y:45,priority:3,required:true,fontSize:7},{id:'ai',name:'aidata01',x:70,y:45,priority:4}],{width:200,height:100});assert.deepEqual(result.map(label=>label.id),['agent','employee']);assert.equal(result[1].fontSize,7);assert.equal(result[1].box.h,11);
});
