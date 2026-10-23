// Small synthesized cues share one context. Rendering never opens audio and
// no sound is scheduled before a deliberate user gesture unlocks the context.
export function createOfficeAudio({window=globalThis.window,storage=globalThis.localStorage,isVisible=()=>true,now=()=>globalThis.performance?.now?.()??Date.now()}={}){
  let muted=false,context=null,master=null,disposed=false,lastPoint=null,lastArea=null;
  const active=new Set(),played=new Map();
  try{muted=storage?.getItem('office-sound-muted')==='1';}catch{}
  function stop(){for(const voice of active){try{voice.stop();}catch{}}active.clear();}
  function tone(frequency,offset,duration,gain,type='sine',endFrequency=frequency){
    if(!context||active.size>=6)return;
    const oscillator=context.createOscillator(),envelope=context.createGain(),start=context.currentTime+offset;
    oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,start);oscillator.frequency.exponentialRampToValueAtTime(endFrequency,start+duration);
    envelope.gain.setValueAtTime(.0001,start);envelope.gain.exponentialRampToValueAtTime(gain,start+.012);envelope.gain.exponentialRampToValueAtTime(.0001,start+duration);
    oscillator.connect(envelope);envelope.connect(master);active.add(oscillator);
    oscillator.onended=()=>{active.delete(oscillator);oscillator.disconnect();envelope.disconnect();};
    oscillator.start(start);oscillator.stop(start+duration+.015);
  }
  function play(kind){
    if(disposed||muted||!isVisible()||context?.state!=='running')return false;
    const time=now(),gap=kind==='hover'?140:kind==='step'?220:260;
    if(time-(played.get(kind)??-Infinity)<gap)return false;
    played.set(kind,time);
    try{
      if(kind==='hover')tone(740,0,.045,.045,'sine',690);
      else if(kind==='enter'){tone(330,0,.19,.12,'sine',440);tone(660,.065,.22,.055);}
      else if(kind==='exit'){tone(440,0,.17,.09,'sine',294);}
      else if(kind==='step')tone(145,0,.052,.08,'triangle',85);
      else if(kind==='select')tone(520,0,.075,.06,'sine',620);
      else return false;
      return true;
    }catch{return false;}
  }
  return{
    get muted(){return muted;},
    unlock(){
      if(disposed||muted||!isVisible())return;
      try{
        if(!context){const Context=window?.AudioContext||window?.webkitAudioContext;if(!Context)return;context=new Context();master=context.createGain();master.gain.value=.12;master.connect(context.destination);}
        if(context.state==='suspended')void Promise.resolve(context.resume()).catch(()=>{});
      }catch{context=null;master=null;}
    },
    setMuted(value){muted=!!value;if(muted)stop();try{storage?.setItem('office-sound-muted',muted?'1':'0');}catch{}return muted;},
    hover(id){if(id)play('hover');},
    context(id){const next=id||null;if(next===lastArea)return;lastArea=next;play(next?'enter':'exit');},
    step({point,walking}={}){
      if(!walking||!Number.isFinite(point?.x)||!Number.isFinite(point?.y)){lastPoint=null;return;}
      if(!lastPoint){lastPoint={...point};return;}
      if(Math.hypot(point.x-lastPoint.x,point.y-lastPoint.y)>=7&&play('step'))lastPoint={...point};
    },
    play,
    pause(){stop();lastPoint=null;},
    destroy(){disposed=true;stop();try{void Promise.resolve(context?.close()).catch(()=>{});}catch{}context=null;master=null;},
  };
}
