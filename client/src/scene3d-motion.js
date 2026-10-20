import { routeBetweenPoints, routeLength, pointAlongRoute, createDeliveryQueue, deliveryParticipants, motionUpdatePolicy, walkingDuration, walkingSample, handoffTiming } from './scene-motion.js';
import { AGENT3D_HOMES, WORK3D_POSITIONS } from './scene3d-layout.js';

export function desired3DPositions(agents=[],{halted=false}={}) {
  const positions=new Map(),perNode={};
  for(const [id,home]of Object.entries(AGENT3D_HOMES)){
    const data=agents.find(agent=>agent.id===id)||{},working=!halted&&data.selected!==false&&data.status==='working'&&WORK3D_POSITIONS[data.nodeId];
    let point={x:home.x,y:home.y};
    if(working&&!(id==='boss'&&data.nodeId==='general_office')){const slots=WORK3D_POSITIONS[data.nodeId],offset=perNode[data.nodeId]||0;perNode[data.nodeId]=offset+1;const [x,y]=slots[offset%slots.length];point={x,y};}
    positions.set(id,point);
  }
  return positions;
}

/* This presentation controller consumes recorded handoffs; it never dispatches,
 * approves or marks a business task complete. It also works without a renderer,
 * so evidence ordering and participant locks can be verified independently. */
export function createScene3DMotion({agents,humans,onDelivery=()=>{},onChange=()=>{},now=()=>performance.now(),reducedMotion=false}={}) {
  const queue=createDeliveryQueue(),walks=new Map(),exchanges=new Map(),desired=new Map(),agentState=new Map();
  let updated=false,runId,epoch=0,destroyed=false,reduced=reducedMotion;
  const person=id=>agents.get(id)||humans.get(id);
  function poseAtRest(id){const actor=agents.get(id);if(!actor)return;const home=AGENT3D_HOMES[id],point=actor.point;
    const seated=!!home?.seated&&Math.hypot(point.x-home.x,point.y-home.y)<1;
    actor.setPose({walking:false,stride:0,bob:0,seated,working:agentState.get(id)?.status==='working',offering:false,receiving:false,carrying:false});
    if(seated)actor.facePoint({x:point.x,y:point.y-100});
  }
  function position(id,point){const actor=agents.get(id);if(!actor)return;actor.point={x:point.x,y:point.y};actor.setPosition(point);}
  function stop(id){walks.delete(id);agents.get(id)?.setPose({walking:false,stride:0,bob:0});}
  function walk(id,target,{event,kind='work',onArrive}={}){
    const actor=agents.get(id);if(!actor||!target){onArrive?.();return;}stop(id);
    const route=routeBetweenPoints(actor.point,target),length=routeLength(route),token=epoch;
    actor.setPose({seated:false,working:false,walking:!reduced&&length>1,carrying:!!event&&!deliveryParticipants(event)?.collecting});
    if(reduced||length<1){position(id,target);if(token===epoch&&!destroyed)onArrive?.();return;}
    walks.set(id,{route,event,kind,started:now(),duration:walkingDuration(route),onArrive,token});onChange();
  }
  function resume(id){
    if(queue.locked(id)||walks.get(id)?.event)return;
    const actor=agents.get(id),target=desired.get(id);if(!actor||!target)return;
    const existing=walks.get(id);if(existing&&Math.hypot(existing.route.at(-1).x-target.x,existing.route.at(-1).y-target.y)<1)return;
    if(Math.hypot(actor.point.x-target.x,actor.point.y-target.y)<1){poseAtRest(id);return;}
    walk(id,target,{onArrive:()=>poseAtRest(id)});
  }
  function beginExchange(event,pair,recipient,near){
    const actor=agents.get(pair.mover),receiver=person(pair.recipient);if(!actor||!receiver){queue.finish(event._deliveryKey);return;}
    actor.facePoint(recipient);receiver.facePoint(actor.point);actor.setPose({walking:false,offering:!pair.collecting,carrying:!pair.collecting});receiver.setPose({receiving:!pair.collecting,offering:!!pair.collecting,carrying:!!pair.collecting});
    exchanges.set(event._deliveryKey,{event,pair,recipient,near,started:now(),timing:handoffTiming(reduced),acknowledged:false,token:epoch});onChange();
  }
  function startReady(){
    if(destroyed)return;
    for(const event of queue.startReady()){
      const pair=deliveryParticipants(event),actor=agents.get(pair?.mover),receiver=person(pair?.recipient);
      if(!actor||!receiver){queue.finish(event._deliveryKey);continue;}
      // A receiver in transit is held in place before the route is planned.
      if(!pair.recipientHuman)stop(pair.recipient);
      receiver.setPose({walking:false,seated:false,receiving:true});
      const recipient={...receiver.point},route=routeBetweenPoints(actor.point,recipient),length=routeLength(route),near=pointAlongRoute(route,length>22?(length-22)/length:0);
      walk(pair.mover,near,{event,kind:pair.collecting?'collecting':'delivering',onArrive:()=>beginExchange(event,pair,recipient,near)});
    }
  }
  function reset(){epoch++;walks.clear();exchanges.clear();queue.clear();for(const actor of [...agents.values(),...humans.values()])actor.setPose({walking:false,stride:0,bob:0,offering:false,receiving:false,carrying:false});}
  function update(state={}){
    if(destroyed)return;
    const nextId=state.runId??null,policy=motionUpdatePolicy({hasUpdated:updated,previousRunId:runId,runId:nextId,animateEvents:state.animateEvents,runStatus:state.runStatus||state.status});
    if(policy.reset)reset();runId=nextId;
    const data=Array.isArray(state.agents)?state.agents:Object.values(state.agents||{}),next=desired3DPositions(data,{halted:policy.halted});
    for(const [id,point]of next){agentState.set(id,data.find(a=>a.id===id)||{});desired.set(id,point);if(policy.reset&&!policy.animate||!agents.get(id)?.point)position(id,point);if(policy.reset)poseAtRest(id);}
    queue.ingest(state.logs||[],{animate:policy.animate});startReady();
    if(policy.animate)for(const id of agents.keys())resume(id);
    updated=true;onChange();return policy;
  }
  function tick(time=now()){
    if(destroyed)return false;
    for(const [id,motion]of [...walks]){
      if(motion.token!==epoch){walks.delete(id);continue;}
      const sample=walkingSample(motion.route,time-motion.started,motion.duration);position(id,sample);agents.get(id)?.setPose({walking:!sample.arrived,heading:sample.heading,stride:sample.stride,bob:sample.bob});
      if(sample.arrived){walks.delete(id);agents.get(id)?.setPose({walking:false,stride:0,bob:0});motion.onArrive?.();}
    }
    for(const [key,exchange]of [...exchanges]){
      if(exchange.token!==epoch){exchanges.delete(key);continue;}
      const elapsed=time-exchange.started,{event,pair,timing}=exchange,actor=agents.get(pair.mover),receiver=person(pair.recipient);
      exchange.progress=timing.transfer<=timing.approach?(elapsed>=timing.transfer?1:0):Math.max(0,Math.min(1,(elapsed-timing.approach)/(timing.transfer-timing.approach)));
      if(!exchange.acknowledged&&elapsed>=timing.transfer){exchange.acknowledged=true;actor?.setPose({offering:false,carrying:!!pair.collecting,receiving:!!pair.collecting});receiver?.setPose({offering:false,carrying:!pair.collecting,receiving:true});onDelivery(event);onChange();}
      if(elapsed>=timing.total){exchanges.delete(key);queue.finish(key);actor?.setPose({offering:false,receiving:false,carrying:false});receiver?.setPose({offering:false,receiving:false,carrying:false});if(pair.recipientHuman){const seated=['owner','investment_owner'].includes(pair.recipient);receiver?.setPose({seated});if(seated)receiver.facePoint({x:receiver.point.x,y:receiver.point.y-100});}
        startReady();resume(pair.mover);if(!pair.recipientHuman)resume(pair.recipient);onChange();}
    }
    return walks.size>0||exchanges.size>0;
  }
  return {update,tick,reset,
    get walks(){return walks;},get exchanges(){return exchanges;},get queue(){return queue;},get activeCount(){return queue.activeCount;},get pendingCount(){return queue.pendingCount;},
    setReducedMotion(value){reduced=!!value;if(!reduced||destroyed)return;for(const [id,motion]of [...walks]){walks.delete(id);position(id,motion.route.at(-1));agents.get(id)?.setPose({walking:false,stride:0,bob:0});motion.onArrive?.();}for(const exchange of exchanges.values()){const elapsed=now()-exchange.started;exchange.timing=handoffTiming(true);exchange.started=now()-Math.min(elapsed,exchange.timing.total);}onChange();},
    shiftTime(milliseconds){const current=now();for(const motion of walks.values())motion.started+=Math.min(milliseconds,Math.max(0,current-motion.started));for(const exchange of exchanges.values())exchange.started+=Math.min(milliseconds,Math.max(0,current-exchange.started));},
    destroy(){reset();destroyed=true;},
  };
}
