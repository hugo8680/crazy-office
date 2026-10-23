import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficeAudio} from '../src/office-audio.mjs';

function fixture(initial='0'){
  let time=0,visible=true,created=0;const voices=[],writes=[];
  const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
  class Context{
    constructor(){created++;this.currentTime=0;this.state='suspended';this.destination={};}
    createGain(){return{gain:param(),connect(){},disconnect(){}};}
    createOscillator(){const voice={frequency:param(),connect(){},disconnect(){},start(at){this.started=at;},stop(at){this.stopped=at;}};voices.push(voice);return voice;}
    async resume(){this.state='running';}async close(){this.state='closed';}
  }
  const audio=createOfficeAudio({window:{AudioContext:Context},storage:{getItem:()=>initial,setItem:(key,value)=>writes.push([key,value])},now:()=>time,isVisible:()=>visible});
  return{audio,voices,writes,get created(){return created;},advance(ms){time+=ms;},hide(){visible=false;}};
}
test('scene callbacks never create or unlock audio before a user gesture',()=>{
  const h=fixture();h.audio.hover('finance');h.audio.context('finance');h.audio.step({walking:true,point:{x:1,y:1}});assert.equal(h.created,0);assert.equal(h.voices.length,0);
  h.audio.unlock();assert.equal(h.created,1);h.audio.hover('hr');assert.equal(h.voices.length,1);h.audio.unlock();assert.equal(h.created,1);h.audio.destroy();
});
test('hover and movement cues are rate limited; stationary updates do not produce footsteps',()=>{
  const h=fixture();h.audio.unlock();h.audio.hover('hr');h.audio.hover('legal');assert.equal(h.voices.length,1);h.advance(150);h.audio.hover('legal');assert.equal(h.voices.length,2);
  h.audio.step({walking:true,point:{x:10,y:10}});h.audio.step({walking:true,point:{x:10,y:10}});assert.equal(h.voices.length,2);
  h.audio.step({walking:true,point:{x:20,y:10}});assert.equal(h.voices.length,3);h.audio.step({walking:true,point:{x:30,y:10}});assert.equal(h.voices.length,3);h.advance(230);h.audio.step({walking:true,point:{x:40,y:10}});assert.equal(h.voices.length,4);h.audio.destroy();
});
test('mute persists independently of the camera and cancels scheduled sound',()=>{
  const h=fixture('1');h.audio.unlock();assert.equal(h.created,0);h.audio.setMuted(false);h.audio.unlock();h.audio.play('enter');assert.equal(h.voices.length,2);h.audio.setMuted(true);assert.ok(h.voices.every(voice=>voice.stopped===undefined));assert.equal(h.audio.play('select'),false);assert.deepEqual(h.writes,[['office-sound-muted','0'],['office-sound-muted','1']]);h.audio.destroy();
});
test('hidden pages and unavailable browser audio remain silent and safe',()=>{
  const h=fixture();h.audio.unlock();h.hide();assert.equal(h.audio.play('enter'),false);h.audio.destroy();h.audio.unlock();assert.equal(h.created,1);
  const unavailable=createOfficeAudio({window:{},storage:{getItem(){throw Error();},setItem(){throw Error();}}});unavailable.unlock();unavailable.setMuted(true);unavailable.destroy();
});
