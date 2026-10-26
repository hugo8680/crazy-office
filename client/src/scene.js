/* The office is also the network: every visible endpoint is selectable. */
import {BULLETIN_SECTIONS,bulletinTile} from './bulletin-sections.mjs';
import { HUMAN_EMPLOYEES } from './people.js';
import { routeBetweenPoints, routeLength, pointAlongRoute, createDeliveryQueue, deliveryParticipants, deliveryKey, motionUpdatePolicy, walkingDuration, walkingSample, handoffTiming, createViewTween } from './scene-motion.js';
import {createOfficePresenceMotion} from './erp-presence.js';
import {officeArea} from './office-navigation.mjs';
import {clampOfficeScale,officeWheelScale,officePinchScale,officeCameraChanged,createOfficeWheelInput,officeScreenDirection,OFFICE_DEPARTMENT_CAMERA_POLICY} from './office-camera.mjs';
import {greetingForPerson} from './person-greeting.mjs';
import {mountOfficeAmbient} from './office-ambient.mjs';
import {employeeAppearance,employeeAppearanceKey,employeeAppearanceStyle} from './employee-appearance.mjs';
import {organizationOccupant,subscribeOrganizationOccupants} from './organization-occupants.mjs';
import {selectOfficeNameLabels} from './person-labels.mjs';
import {createOfficeSVGVariants} from './office-svg-variants.mjs';
import { OFFICE_WORLD, OFFICE_ROOMS, OFFICE_DATA_CENTER, OFFICE_BULLETIN_AREA, OFFICE_NODE_ANCHORS, OFFICE_AGENT_HOMES, OFFICE_WORK_POSITIONS, OFFICE_DETAIL_ZOOM, officeSeatsForView, officeTeamDetail, officeDisplayPoint, officeCanonicalPoint, officePointInTeam } from './organization.mjs';
import {renderOrganizationFloor, renderOrganizationPositionContents, renderOfficeTeamFloor, ORGANIZATION_POSITION_META} from './scene-floor2d.mjs';
const WORLD_CX=OFFICE_WORLD.width/2,WORLD_CY=OFFICE_WORLD.height/2;
const INITIAL_VIEW_BOX=`0 0 ${OFFICE_WORLD.width} ${OFFICE_WORLD.height}`;
const NODE_META=Object.freeze(Object.fromEntries(Object.entries(OFFICE_NODE_ANCHORS).map(([id,node])=>[id,{...node,w:Math.max(70,node.label.length*8+24),ly:24}])));
const AGENT_META=Object.freeze(Object.fromEntries(Object.entries(OFFICE_AGENT_HOMES).map(([id,home])=>[id,{...home,color:employeeAppearance(true,id).uniform}])));
const WORK_POSITIONS=OFFICE_WORK_POSITIONS;
const ROOM_IDS=new Set(OFFICE_ROOMS.map(room=>room.id));
const NETWORK_IDS=new Set(['internet','firewall','core','server','storage','ups','access']);

let sceneCounter = 0;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function mountScene(container, { onSelectNode = () => {}, onEnterArea = () => {}, onNavigationContext = () => {}, onPresenceStep = () => {}, onCameraIntent = () => {}, onDepartmentHover = () => {}, onSelectBulletin = () => {}, onHoverBulletin = () => {}, onLeaveBulletin = () => {}, onSelectAgent = () => {}, onSelectHuman = () => {}, onSelectSeat = () => {}, onSelectPostEmployee = () => {}, onMovePoint = () => {}, onDelivery = () => {}, onViewChange = () => {} } = {}) {
  const uid = `cnl-office-${++sceneCounter}`;
  const symbolBounds = { plant:[-20,-44,40,53], person:[-25,-25,50,71], seated:[-26,-59,52,63], desk:[-3,-3,114,65], server:[-3,-5,58,110], switch:[-40,-14,80,35], cup:[-6,-8,16,19], sofa:[-4,-4,99,50], chair:[-14,-12,28,35],empty_seat:[-26,-59,52,63] };
  const use = (name, x, y, scale = 1, extra = '') => {
    const [sx,sy,width,height] = symbolBounds[name];
    return `<use href="#${uid}-${name}" x="${sx}" y="${sy}" width="${width}" height="${height}" overflow="visible" transform="translate(${x} ${y}) scale(${scale})" ${extra}/>`;
  };
  const seated = (x, y, shirt, hair = '#3d393d', scale = 1, lounge = false, back = false,appearance=null,{chair=true}={}) => use('seated', x, y, scale, `class="cnl-seated" style="${appearance?employeeAppearanceStyle(appearance):`--shirt:${shirt};--hair:${hair}`};--chair-display:${lounge||!chair?'none':'block'};--typing-display:${lounge?'none':'block'};--resting-display:${lounge?'block':'none'};--front-facing:${back?'none':'block'};--back-facing:${back?'block':'none'}"`);
  const plant = (x, y, scale = 1) => use('plant', x, y, scale);
  const paths = [...NETWORK_IDS].filter(id=>id!=='core').map(id=>{
    const a=NODE_META.core,b=NODE_META[id];return ['core',id,`M${a.x} ${a.y}H${b.x}V${b.y}`];
  });
  const linkMarkup=paths.map(([a,b,d])=>`<g class="cnl-link" data-a="${a}" data-b="${b}"><path class="cnl-cable-under" d="${d}"/><path class="cnl-cable" d="${d}"/></g>`).join('');
  const hotspots=Object.entries(NODE_META).filter(([id])=>!ROOM_IDS.has(id)&&id!=='bulletin').map(([id,n])=>`<g class="cnl-node" data-node="${id}" data-status="online" tabindex="${NETWORK_IDS.has(id)?0:-1}" role="button" aria-label="查看${esc(n.label)}" transform="translate(${n.x} ${n.y})"${NETWORK_IDS.has(id)?'':' style="display:none" aria-hidden="true"'}><circle class="cnl-fault-halo" r="25"/><circle class="cnl-hit-ring" r="23"/><circle class="cnl-hit-area" r="25"/><g class="cnl-node-label" transform="translate(${-n.w/2} ${n.ly})"><rect width="${n.w}" height="19" rx="7"/><circle class="cnl-status-dot" cx="9" cy="9.5" r="3"/><text x="17" y="12.6">${esc(n.label)}</text></g><g class="cnl-alert-mark" transform="translate(16 -23)"><circle r="8"/><text y="3.5" text-anchor="middle">!</text></g></g>`).join('');

  container.innerHTML = `<svg class="cnl-office-scene" xmlns="http://www.w3.org/2000/svg" viewBox="${INITIAL_VIEW_BOX}" role="group" aria-label="办公室" tabindex="0" aria-keyshortcuts="Home" preserveAspectRatio="xMidYMid meet">
  <defs>
    <pattern id="${uid}-grid" width="26" height="26" patternUnits="userSpaceOnUse"><path d="M26 0H0V26" fill="none" stroke="#48564e" stroke-opacity=".035" stroke-width="1"/></pattern>
    <pattern id="${uid}-wood" width="18" height="52" patternUnits="userSpaceOnUse"><rect width="18" height="52" fill="#e6d8b9"/><path d="M18 0V52M0 26H18" fill="none" stroke="#cfbf9f" stroke-width=".65"/></pattern>
    <pattern id="${uid}-floor" width="68" height="28" patternUnits="userSpaceOnUse"><path d="M0 28H68M34 0V28M0 0V14M68 14V28" stroke="#a79b81" stroke-opacity=".12" fill="none" stroke-width=".7"/></pattern>
    <linearGradient id="${uid}-roomlight" x2="1" y2="1"><stop stop-color="#ffffff" stop-opacity=".32"/><stop offset=".7" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${uid}-floorlight" x2="0" y2="1"><stop stop-color="#fffef9"/><stop offset="1" stop-color="#eceee2"/></linearGradient>
    <linearGradient id="${uid}-glass" x2="0" y2="1"><stop stop-color="#cceae8"/><stop offset="1" stop-color="#e8f5ec"/></linearGradient>
    <linearGradient id="${uid}-screen" x2="1" y2="1"><stop stop-color="#306e70"/><stop offset="1" stop-color="#183c48"/></linearGradient>
    <symbol id="${uid}-plant" viewBox="-20 -44 40 53"><ellipse cy="6" rx="15" ry="4" fill="#334e3a" opacity=".09"/><path d="M-11-9H11L8 6Q0 10-8 6Z" fill="#f6e0bd" stroke="#4f6052" stroke-width="1.1"/><ellipse cy="-9" rx="11" ry="3.5" fill="#afbd8d" stroke="#4f6052" stroke-width="1.1"/><path d="M0-9V-34M0-18Q-16-16-13-32Q1-33 0-18M0-24Q15-25 12-40Q-1-38 0-24M0-12Q13-10 16-24Q3-25 0-12M0-30Q-11-30-9-42Q3-41 0-30" fill="#75ae82" stroke="#4b7960" stroke-width="1.1" stroke-linecap="round"/></symbol>
    <symbol id="${uid}-person" viewBox="-25 -25 50 71">
      <ellipse class="cnl-person-shadow" cy="40" rx="16" ry="4" fill="#344c48" opacity=".13"/>
      <g class="cnl-person-leg-left" style="transform-origin:-6px 22px"><path d="M-6 22L-7 31L-8 38" fill="none" stroke="var(--trousers,#3c4d5b)" stroke-width="7" stroke-linecap="round"/><path d="M-10 40H-3" stroke="var(--shoes,#283e48)" stroke-width="5" stroke-linecap="round"/><path d="M-10 41H-3" stroke="#bbc7c5" stroke-width="1" stroke-linecap="round"/></g>
      <g class="cnl-person-leg-right" style="transform-origin:6px 22px"><path d="M6 22L7 31L8 38" fill="none" stroke="var(--trousers,#455967)" stroke-width="7" stroke-linecap="round"/><path d="M5 40H12" stroke="var(--shoes,#283e48)" stroke-width="5" stroke-linecap="round"/><path d="M5 41H12" stroke="#bbc7c5" stroke-width="1" stroke-linecap="round"/></g>
      <g class="cnl-person-arm-left" style="transform-origin:-10px 6px;animation:var(--ambient-left-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M-10 6Q-15 12-15 20" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="7" stroke-linecap="round"/><path d="M-15 19L-15 23" stroke="var(--skin,#efc7a8)" stroke-width="5" stroke-linecap="round"/></g>
      <g class="cnl-person-arm-right" style="transform-origin:10px 6px;animation:var(--ambient-right-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M10 6Q15 12 15 20" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="7" stroke-linecap="round"/><path d="M15 19L15 23" stroke="var(--skin,#efc7a8)" stroke-width="5" stroke-linecap="round"/></g>
      <g class="cnl-person-torso" style="transform-origin:0 -19px;animation:var(--ambient-body-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M-10 4Q0-1 10 4L11 23Q0 28-11 23Z" fill="var(--shirt,#73aaa4)" stroke="#3e5a5b" stroke-width=".8"/><path d="M-2 3L0 11L3 3" fill="#f7f4e9" opacity=".82"/><path d="M0 11V24" stroke="#fff" opacity=".2" stroke-width="1"/><path d="M-9 20Q0 23 10 20" fill="none" stroke="#203e48" opacity=".13" stroke-width="1.5"/></g>
      <g class="cnl-garment-details" aria-hidden="true" style="transform-origin:0 -19px;animation:var(--ambient-body-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><g style="display:var(--garment-open,none)"><path d="M-3 3H3L4 24H-4Z" fill="var(--inner-shirt,#eee5d3)"/><path d="M-6 3L-2 12L-5 15M6 3L2 12L5 15" fill="none" stroke="var(--cloth-trim,#b2c0ad)" stroke-width="1"/></g><g style="display:var(--garment-pocket,none)"><path d="M-8 10H-3V15H-8Z" fill="none" stroke="var(--cloth-trim,#b2c0ad)" stroke-width=".8"/><circle cx="1" cy="17" r=".7" fill="var(--cloth-trim,#b2c0ad)"/></g><g style="display:var(--garment-knit,none)" stroke="var(--cloth-trim,#b2c0ad)" stroke-width=".8" opacity=".65"><path d="M-8 12H8M-9 17H9M-9 22H9"/></g><g style="display:var(--garment-hood,none)"><path d="M-8 4Q0 14 8 4" fill="none" stroke="var(--cloth-trim,#eee)" stroke-width="2.5"/><path d="M-3 9V15M3 9V15M-6 20Q0 17 6 20" fill="none" stroke="var(--cloth-trim,#eee)" stroke-width=".8"/></g></g><g class="cnl-person-head" style="transform-origin:0 -10px;animation:var(--ambient-head-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><rect x="-3" y="-2" width="6" height="8" rx="2" fill="var(--skin,#e5b38d)"/><ellipse cy="-10" rx="10.4" ry="11.4" fill="var(--skin,#f2ccad)" stroke="#716c60" stroke-opacity=".5" stroke-width=".65"/><ellipse cx="-10" cy="-9" rx="2" ry="3" fill="var(--earcap,#e9bd9b)"/><ellipse cx="10" cy="-9" rx="2" ry="3" fill="var(--earcap,#e9bd9b)"/><path d="M-10-8Q-13-22 0-23Q14-23 11-8L8-15Q2-10-4-16L-8-12Z" fill="var(--hair,#3d393d)" style="display:var(--natural,block)"/><g class="cnl-synthetic-shell" style="display:var(--synthetic,none)"><rect x="-9" y="-18" width="18" height="20" rx="6" fill="var(--skin,#e4eddf)" stroke="#aac0b6" stroke-width=".7"/><path d="M-7-18Q0-22 7-18" fill="none" stroke="var(--earcap,#537b7a)" stroke-width="3" stroke-linecap="round"/></g><g style="display:var(--synthetic,none)"><rect x="-10.8" y="-12" width="3" height="6" rx="1.5" fill="var(--earcap,#537b7a)"/><rect x="7.8" y="-12" width="3" height="6" rx="1.5" fill="var(--earcap,#537b7a)"/><path d="M-7-5Q0 1 7-5" fill="none" stroke="#a8bfb6" stroke-width=".7"/><path d="M-4-10H-2M2-10H4" stroke="var(--eye,#397879)" stroke-width="1.7" stroke-linecap="round"/></g><g class="cnl-person-face-neutral"><path d="M-3-5Q0-3 3-5" fill="none" stroke="#a86f60" stroke-width=".9" stroke-linecap="round"/><circle cx="-4" cy="-10" r=".9" fill="var(--eye,#3f4548)"/><circle cx="4" cy="-10" r=".9" fill="var(--eye,#3f4548)"/><path d="M-6-13H-3M3-13H6" stroke="#7c6253" stroke-width=".7" stroke-linecap="round"/></g><g class="cnl-person-face-happy" fill="none" stroke-linecap="round"><path d="M-6-9Q-4-12-2-9M2-9Q4-12 6-9" stroke="#4f4841" stroke-width="1.2"/><path d="M-3.5-5Q0 0 3.5-5Z" fill="#b76f5b" stroke="#a86f60" stroke-width=".7"/><path d="M-2.2-4.5H2.2" stroke="#fff6e9" stroke-width="1.1"/></g><ellipse cx="-7" cy="-6" rx="2" ry="1" fill="#e9a994" opacity=".6"/><ellipse cx="7" cy="-6" rx="2" ry="1" fill="#e9a994" opacity=".6"/></g>
    </symbol>
    <symbol id="${uid}-empty_seat" viewBox="-26 -59 52 63">      <g class="cnl-seat"><path d="M0-17V-3M-15 0H15M0-3L-13 1M0-3L13 1" fill="none" stroke="#71868a" stroke-width="2" stroke-linecap="round"/><rect x="-17" y="-39" width="34" height="30" rx="11" fill="#607b82" stroke="#405e64" stroke-width="1"/><rect x="-14" y="-36" width="28" height="20" rx="8" fill="#88a6aa"/><path d="M-12-31H12M-12-26H12" stroke="#b6cbcc" opacity=".35" stroke-width="1"/><path d="M-15-17H15" stroke="#a9b9b8" stroke-width="5" stroke-linecap="round"/></g></symbol>
    <symbol id="${uid}-seated" viewBox="-26 -59 52 63">
      <ellipse class="cnl-person-shadow" cy="1" rx="23" ry="4" fill="#344c48" opacity=".12"/>
      <g class="cnl-seat" style="display:var(--chair-display,block)"><path d="M0-17V-3M-15 0H15M0-3L-13 1M0-3L13 1" fill="none" stroke="#71868a" stroke-width="2" stroke-linecap="round"/><rect x="-17" y="-39" width="34" height="30" rx="11" fill="#607b82" stroke="#405e64" stroke-width="1"/><rect x="-14" y="-36" width="28" height="20" rx="8" fill="#88a6aa"/><path d="M-12-31H12M-12-26H12" stroke="#b6cbcc" opacity=".35" stroke-width="1"/><path d="M-15-17H15" stroke="#a9b9b8" stroke-width="5" stroke-linecap="round"/></g>
      <g class="cnl-person-leg-left"><path d="M-5-17L-12-12L-12-3" fill="none" stroke="var(--trousers,#3b4d5d)" stroke-width="7" stroke-linecap="round"/><path d="M-16-1H-9" stroke="var(--shoes,#2d414b)" stroke-width="5" stroke-linecap="round"/><path d="M-16 1H-9" stroke="#a7babd" stroke-width="1" stroke-linecap="round"/></g>
      <g class="cnl-person-leg-right"><path d="M5-17L12-12L12-3" fill="none" stroke="var(--trousers,#475b69)" stroke-width="7" stroke-linecap="round"/><path d="M9-1H16" stroke="var(--shoes,#2d414b)" stroke-width="5" stroke-linecap="round"/><path d="M9 1H16" stroke="#a7babd" stroke-width="1" stroke-linecap="round"/></g>
      <g class="cnl-person-torso" style="transform-origin:0 -19px;animation:var(--ambient-body-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M-10-36Q0-40 10-36L12-19Q1-12-12-19Z" fill="var(--shirt,#73aaa4)" stroke="#476164" stroke-width=".8"/><path d="M-3-36L0-29L3-36" fill="#f7f4e9" opacity=".85"/><path d="M0-28V-18" stroke="#fff" opacity=".25" stroke-width="1"/></g>
      <g class="cnl-person-arm-left" style="transform-origin:-10px -34px;display:var(--typing-display,block);animation:var(--ambient-left-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M-10-34L-13-36L-11-43" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="6" stroke-linecap="round"/><path d="M-11-43L-6-44" stroke="var(--skin,#efc7a8)" stroke-width="4.5" stroke-linecap="round"/></g>
      <g class="cnl-person-arm-right" style="transform-origin:10px -34px;display:var(--position-arm,var(--typing-display,block));animation:var(--ambient-right-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><path d="M10-34L13-36L11-43" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="6" stroke-linecap="round"/><path d="M11-43L6-44" stroke="var(--skin,#efc7a8)" stroke-width="4.5" stroke-linecap="round"/></g>
      <g class="cnl-seated-resting-arms" style="display:var(--resting-display,none)"><path d="M-10-34L-14-23L-6-20M10-34L14-23L6-20" fill="none" stroke="var(--shirt,#73aaa4)" stroke-width="6" stroke-linecap="round"/><path d="M-6-20H-2M6-20H2" stroke="var(--skin,#efc7a8)" stroke-width="4.5" stroke-linecap="round"/></g>
      <g class="cnl-garment-details" aria-hidden="true" style="transform-origin:0 -19px;animation:var(--ambient-body-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><g style="display:var(--garment-open,none)"><path d="M-3-36H3L4-18H-4Z" fill="var(--inner-shirt,#eee5d3)"/><path d="M-6-35L-2-28L-5-25M6-35L2-28L5-25" fill="none" stroke="var(--cloth-trim,#b2c0ad)" stroke-width="1"/></g><g style="display:var(--garment-pocket,none)"><path d="M-8-29H-3V-24H-8Z" fill="none" stroke="var(--cloth-trim,#b2c0ad)" stroke-width=".8"/></g><g style="display:var(--garment-knit,none)" stroke="var(--cloth-trim,#b2c0ad)" stroke-width=".8" opacity=".65"><path d="M-8-28H8M-9-23H9M-8-19H8"/></g><g style="display:var(--garment-hood,none)"><path d="M-8-36Q0-27 8-36" fill="none" stroke="var(--cloth-trim,#eee)" stroke-width="2.5"/><path d="M-3-32V-26M3-32V-26" fill="none" stroke="var(--cloth-trim,#eee)" stroke-width=".8"/></g></g><g class="cnl-person-head" style="display:var(--front-facing,block);transform-origin:0 -48px;animation:var(--ambient-head-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><rect x="-3" y="-40" width="6" height="6" rx="2" fill="var(--skin,#e5b38d)"/><ellipse cy="-48" rx="10" ry="10.6" fill="var(--skin,#f2ccad)" stroke="#716c60" stroke-opacity=".5" stroke-width=".65"/><path d="M-10-47Q-13-59 0-59Q13-59 10-46L7-52Q1-49-4-54L-8-50Z" fill="var(--hair,#3d393d)" style="display:var(--natural,block)"/><g class="cnl-synthetic-shell" style="display:var(--synthetic,none)"><rect x="-9" y="-56" width="18" height="20" rx="6" fill="var(--skin,#e4eddf)" stroke="#aac0b6" stroke-width=".7"/><path d="M-7-56Q0-60 7-56" fill="none" stroke="var(--earcap,#537b7a)" stroke-width="3" stroke-linecap="round"/></g><g style="display:var(--synthetic,none)"><rect x="-11" y="-50" width="3" height="6" rx="1.5" fill="var(--earcap,#537b7a)"/><rect x="8" y="-50" width="3" height="6" rx="1.5" fill="var(--earcap,#537b7a)"/><path d="M-7-43Q0-37 7-43" fill="none" stroke="#a8bfb6" stroke-width=".7"/></g><g style="display:var(--position-neutral,block)"><circle cx="-3.8" cy="-48" r=".9" fill="var(--eye,#3f4548)"/><circle cx="3.8" cy="-48" r=".9" fill="var(--eye,#3f4548)"/><path d="M-2.5-43Q0-42 2.5-43" fill="none" stroke="#a86f60" stroke-width=".9" stroke-linecap="round"/></g><g style="display:var(--position-happy,none)" fill="none" stroke-linecap="round"><path d="M-6-48Q-4-51-2-48M2-48Q4-51 6-48" stroke="#4f4841" stroke-width="1.25"/><path d="M-3.5-43Q0-38 3.5-43Z" fill="#b76f5b" stroke="#a86f60" stroke-width=".7"/><path d="M-2-42.7H2" stroke="#fff6e9" stroke-width="1"/></g><ellipse cx="-7" cy="-44" rx="2" ry="1" fill="#e9a994" opacity=".6"/><ellipse cx="7" cy="-44" rx="2" ry="1" fill="#e9a994" opacity=".6"/></g>
      <g class="cnl-person-head cnl-person-head-back" style="display:var(--back-facing,none);transform-origin:0 -48px;animation:var(--ambient-head-animation,none) var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both;"><rect x="-3" y="-40" width="6" height="6" rx="2" fill="var(--skin,#e5b38d)"/><ellipse cy="-48" rx="10" ry="10.6" fill="var(--skin,#f2ccad)" stroke="#716c60" stroke-opacity=".5" stroke-width=".65"/><ellipse cx="-9.5" cy="-46" rx="2" ry="2.7" fill="var(--earcap,#e8bd9c)"/><ellipse cx="9.5" cy="-46" rx="2" ry="2.7" fill="var(--earcap,#e8bd9c)"/><path d="M-9-45Q-13-59 0-59Q13-59 9-45L6-39Q0-36-6-39Z" fill="var(--hair,#3d393d)" style="display:var(--natural,block)"/><g style="display:var(--synthetic,none)"><rect x="-9" y="-56" width="18" height="20" rx="6" fill="var(--skin,#e4eddf)" stroke="#aac0b6" stroke-width=".7"/><rect x="-4" y="-49" width="8" height="3" rx="1.5" fill="var(--earcap,#537b7a)"/></g><path d="M-6-54Q0-58 6-53M-5-42Q0-40 5-42" fill="none" stroke="#b3a394" opacity=".28" stroke-width="1" stroke-linecap="round"/></g>
    </symbol>
    <symbol id="${uid}-desk" viewBox="-3 -3 114 65"><ellipse cx="52" cy="54" rx="53" ry="9" fill="#4d5b59" opacity=".07"/><path d="M5 40V54M98 40V54" stroke="#7d8b83" stroke-width="5"/><path d="M0 5L7 0H104L108 6V44Q108 49 102 49H6Q0 49 0 43Z" fill="#d1b48e" stroke="#a49072" stroke-width=".75"/><rect x="0" y="0" width="108" height="43" rx="6" fill="#e6c79c" stroke="#a49072" stroke-width=".75"/><rect x="28" y="3" width="48" height="28" rx="3" fill="#344f4b" stroke="#29433e" stroke-width=".8"/><rect x="31" y="6" width="42" height="21" rx="1" fill="var(--screen,#a7d5db)"/><path class="cnl-screen-sheen" d="M44 6H57L45 27H32Z" fill="#fff" opacity=".12"/><path d="M35 11H53M35 15H47M35 19H57" stroke="#fff" opacity=".66" stroke-width="1.5"/><path d="M62 10L69 17L62 24" fill="none" stroke="#fff" opacity=".45" stroke-width="2"/><path d="M52 31V34M44 35H60" stroke="#576566" stroke-width="2.5" stroke-linecap="round"/><rect x="34" y="36" width="36" height="5" rx="1.5" fill="#c6cfc4" stroke="#677b71" stroke-width=".7"/><path d="M39 38.5H64" stroke="#84958b" stroke-width=".7" stroke-dasharray="2 1"/><ellipse cx="78" cy="38" rx="3" ry="4" fill="#dce2d4" stroke="#7f8b80" stroke-width=".7"/><rect x="10" y="24" width="13" height="14" rx="1" fill="#f1d6ab" transform="rotate(-8 10 24)"/><path d="M12 29H20M12 32H19" stroke="#bdad8b" stroke-width=".8"/></symbol>
    <symbol id="${uid}-server" viewBox="-3 -5 58 110"><ellipse cx="26" cy="99" rx="28" ry="6" fill="#344b46" opacity=".1"/><path d="M0 3L8-2H50L45 5Z" fill="#829497" stroke="#354b51" stroke-width="1.2"/><path d="M45 5L50-2V87L45 95Z" fill="#344d55" stroke="#354b51" stroke-width="1.2"/><rect x="0" y="4" width="45" height="92" rx="3" fill="#496169" stroke="#354b51" stroke-width="1.3"/><rect x="4" y="9" width="37" height="80" rx="2" fill="#263e48"/><g fill="#3f555e" stroke="#1d3540" stroke-width=".6"><rect x="7" y="13" width="31" height="13" rx="1.5"/><rect x="7" y="30" width="31" height="13" rx="1.5"/><rect x="7" y="47" width="31" height="13" rx="1.5"/><rect x="7" y="64" width="31" height="13" rx="1.5"/></g><g stroke="#89aaa9" stroke-width="1.1"><path d="M11 18H26M11 21H26M11 35H26M11 38H26M11 52H26M11 55H26M11 69H26M11 72H26"/></g><g class="cnl-server-led" fill="#b6e79c"><circle cx="33" cy="19" r="1.6"/><circle cx="33" cy="36" r="1.6"/><circle cx="33" cy="53" r="1.6"/><circle cx="33" cy="70" r="1.6"/></g><rect x="9" y="82" width="27" height="3" rx="1.5" fill="#738e90"/><path d="M8 96V101M37 96V101" stroke="#465b5d" stroke-width="4" stroke-linecap="round"/></symbol>
    <symbol id="${uid}-switch" viewBox="-40 -14 80 35"><path d="M-35-7L-28-13H35L39-7V11L33 16H-35Z" fill="#91b1a9" stroke="#3f5c5b" stroke-width="1.2"/><rect x="-35" y="-7" width="70" height="20" rx="3" fill="#e0e9d9" stroke="#3f5c5b" stroke-width="1.2"/><g fill="#526c67"><rect x="-27" y="-1" width="6" height="5" rx=".7"/><rect x="-17" y="-1" width="6" height="5" rx=".7"/><rect x="-7" y="-1" width="6" height="5" rx=".7"/><rect x="3" y="-1" width="6" height="5" rx=".7"/><rect x="13" y="-1" width="6" height="5" rx=".7"/></g><circle cx="27" cy="1" r="2.2" fill="#81b774"/><path d="M-26 7H17" stroke="#96a991" stroke-width="1" stroke-dasharray="2 3"/></symbol>
    <symbol id="${uid}-cup" viewBox="-6 -8 16 19"><ellipse cy="8" rx="7" ry="2" fill="#717f72" opacity=".12"/><path d="M5-2Q13-3 10 4Q8 7 4 4" fill="none" stroke="#687f73" stroke-width="1.5"/><path d="M-5-4H6L5 7Q0 10-4 7Z" fill="#fff8e9" stroke="#687f73" stroke-width="1"/><ellipse cx=".5" cy="-4" rx="5.5" ry="2" fill="#9c7e60" stroke="#687f73" stroke-width="1"/><path d="M0-8Q3-11 1-14" fill="none" stroke="#87968b" stroke-width=".7" opacity=".6"/></symbol>
    <symbol id="${uid}-sofa" viewBox="-4 -4 99 50"><ellipse cx="45" cy="41" rx="47" ry="6" fill="#54695e" opacity=".1"/><rect x="3" y="0" width="84" height="34" rx="9" fill="#79a894" stroke="#516f69" stroke-width="1.2"/><rect x="7" y="5" width="76" height="24" rx="6" fill="#b5d2b0" stroke="#6d9387" stroke-width="1"/><rect x="10" y="17" width="33" height="16" rx="4" fill="#d4e2bc" stroke="#769687" stroke-width="1"/><rect x="46" y="17" width="33" height="16" rx="4" fill="#d4e2bc" stroke="#769687" stroke-width="1"/><rect x="0" y="15" width="11" height="23" rx="4" fill="#94bba4" stroke="#516f69" stroke-width="1.1"/><rect x="79" y="15" width="11" height="23" rx="4" fill="#94bba4" stroke="#516f69" stroke-width="1.1"/><path d="M9 38V43M79 38V43" stroke="#6f7d6b" stroke-width="3"/></symbol>
    <symbol id="${uid}-chair" viewBox="-14 -12 28 35"><rect x="-11" y="-8" width="22" height="24" rx="7" fill="#b6b3cc" stroke="#7a7f96" stroke-width="1.1"/><rect x="-8" y="1" width="16" height="11" rx="4" fill="#d3cee1"/><path d="M-8 16V20M8 16V20" stroke="#7a7f96" stroke-width="2.2"/></symbol>
  </defs>
  <style>
    .cnl-office-scene{width:100%;height:100%;display:block;overflow:visible;outline:none;font-family:var(--office-ui-font-sans,"PingFang SC","Microsoft YaHei",sans-serif);user-select:none;touch-action:none;cursor:grab}.cnl-office-scene.is-panning{cursor:grabbing}
    .cnl-office-scene text{pointer-events:none;font-family:var(--office-ui-font-sans,"PingFang SC","Microsoft YaHei",sans-serif)}.cnl-room-title{font-size:14px;font-weight:750;fill:#34473f;letter-spacing:.5px}.cnl-room-en{font-size:7.5px;font-weight:600;fill:#8a9486;letter-spacing:1.1px}.cnl-small{font-size:8px;fill:#7c8b80;letter-spacing:.6px}.cnl-tiny{font-size:6px;fill:#60776f}
    .cnl-cable-under{fill:none;stroke:#fcfcf4;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;opacity:.86}.cnl-cable{fill:none;stroke:#77b9b6;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.7}.cnl-packet{fill:none;stroke:#e5fff4;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:4 130;animation:cnl-datastream 6s linear infinite}.cnl-power-wire{fill:none;stroke:#d0b164;stroke-width:1.7;stroke-dasharray:4 4;stroke-linecap:round;opacity:.75}
    .cnl-links{transition:opacity .25s}.cnl-topology-off .cnl-links{opacity:0}.cnl-link.is-offline .cnl-cable{stroke:#e78b80;stroke-dasharray:4 5;opacity:.85}.cnl-link.is-offline .cnl-packet{display:none}.cnl-link.is-warning .cnl-cable{stroke:#d6ad57}.cnl-link.is-recovering .cnl-cable{stroke:#67a58b}.cnl-link.is-recovering .cnl-packet{stroke:#c7ec9c;animation-duration:2.7s}
    .cnl-node{cursor:pointer;outline:none;--status:#71a78a}.cnl-hit-area{fill:transparent;stroke:none}.cnl-hit-ring{fill:transparent;stroke:#83bca3;stroke-width:1.8;opacity:0;transition:opacity .2s}.cnl-node:hover .cnl-hit-ring,.cnl-node:focus-visible .cnl-hit-ring,.cnl-node.is-selected .cnl-hit-ring{opacity:1}.cnl-node.is-selected .cnl-hit-ring{stroke:#3c7966;stroke-width:2.2;stroke-dasharray:3 3;animation:cnl-rotate 16s linear infinite}.cnl-node-label rect{fill:#fffef7;stroke:#abbba7;stroke-width:.65;opacity:.96}.cnl-node-label text{font-size:8.2px;fill:#52685d;font-weight:650}.cnl-status-dot{fill:var(--status);stroke:white;stroke-width:.8}.cnl-fault-halo{fill:var(--status);opacity:0;stroke:var(--status);stroke-width:1}.cnl-alert-mark{display:none}.cnl-alert-mark circle{fill:#e68c78;stroke:#fffaf0;stroke-width:1.5}.cnl-alert-mark text{fill:white;font-size:10px;font-weight:800}.cnl-node[data-status="warning"]{--status:#d4a450}.cnl-node[data-status="offline"]{--status:#df8076}.cnl-node[data-status="recovering"]{--status:#68a994}.cnl-node[data-status="offline"] .cnl-fault-halo,.cnl-node[data-status="warning"] .cnl-fault-halo{animation:cnl-faultpulse 1.8s ease-in-out infinite}.cnl-node[data-status="offline"] .cnl-alert-mark,.cnl-node[data-status="warning"] .cnl-alert-mark{display:block}.cnl-node[data-status="offline"] .cnl-node-label rect{stroke:#d68b7b;fill:#fff3e9}.cnl-node[data-status="recovering"] .cnl-hit-ring{opacity:.8;stroke:#66a38e;stroke-dasharray:3 3;animation:cnl-rotate 6s linear infinite}.cnl-device[data-status="offline"]{filter:saturate(.35)}.cnl-device[data-status="offline"] .cnl-server-led{fill:#dd8576}.cnl-device[data-status="warning"] .cnl-server-led{fill:#dfb461}.cnl-device[data-status="recovering"] .cnl-server-led{animation:cnl-ledblink .6s alternate infinite}
    .cnl-agent-badge{pointer-events:none;animation:cnl-agentpop .3s ease-out}.cnl-agent-badge .cnl-agent-face{fill:#f8e9cf;stroke:#3e6860;stroke-width:1.3}.cnl-agent-badge text{font-size:9px;fill:#3f6057;font-weight:800}.cnl-agent-badge .cnl-tool-ring{fill:#e9f1dd;stroke:#9bb39c;stroke-width:.8}.cnl-agent-badge .cnl-tool{fill:none;stroke:#547967;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.cnl-agent-badge.is-working .cnl-tool-ring{animation:cnl-toolpulse 1s ease-in-out infinite}.cnl-action-label{font-size:8px!important;font-weight:600!important;fill:#5c7568!important}.cnl-work-indicator{fill:#adcf94;animation:cnl-ledblink 1.3s alternate infinite}
    .cnl-ai-aura{fill:#8ee6d0;stroke:#47aa9b;stroke-width:.7;opacity:.24}.cnl-ai-badge rect{fill:#e5fffa;stroke:#2a9f8d;stroke-width:.6}.cnl-ai-badge text{fill:#176b60;font-size:3.6px;font-weight:900}.cnl-agent.is-working .cnl-ai-aura{opacity:.5;stroke:#28a08c}.cnl-agent{cursor:pointer;outline:none;transition:opacity .2s}.cnl-agent.is-unassigned{opacity:.55}.cnl-agent.is-unassigned:hover,.cnl-agent.is-unassigned:focus-visible{opacity:.85}.cnl-agent-hit{fill:transparent;stroke:none}.cnl-agent-ground{fill:#f7f6e9;stroke:#a8b8a0;stroke-width:.9;opacity:.9}.cnl-agent .cnl-agent-card{fill:#fffef6;stroke:#a5b69d;stroke-width:.7;stroke-dasharray:2 2}.cnl-agent.is-configured .cnl-agent-card{stroke-dasharray:none;stroke:#89a995}.cnl-agent:hover .cnl-agent-card,.cnl-agent:focus-visible .cnl-agent-card,.cnl-agent.is-selected .cnl-agent-card{stroke:#447e6a;stroke-width:1.6;fill:#f9fff4}.cnl-agent-name{fill:#38594b;font-size:8px;font-weight:800}.cnl-agent-type{fill:#248b79;font-size:5px;font-weight:700;letter-spacing:.6px}.cnl-agent-state{fill:#7c8b77;font-size:6px;font-weight:550}.cnl-agent.is-working .cnl-agent-state{fill:#46745c}.cnl-agent .cnl-config-dot{fill:#fffcf1;stroke:#a5b198;stroke-width:1}.cnl-agent.is-configured .cnl-config-dot{fill:#80aa87;stroke:#80aa87}.cnl-agent.is-configured .cnl-config-check{display:block}.cnl-config-check{display:none;fill:none;stroke:#fff;stroke-width:.9;stroke-linecap:round;stroke-linejoin:round}.cnl-agent.is-working .cnl-agent-ground{fill:#d9eacf;stroke:#8fae80;animation:cnl-toolpulse 1.5s ease-in-out infinite}.cnl-agent .cnl-tool-ring{fill:#edf4df;stroke:#95ad8e;stroke-width:.8}.cnl-agent .cnl-tool{fill:none;stroke:#507461;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.cnl-agent .cnl-role-tool{display:none}.cnl-agent.is-working .cnl-role-tool{display:block;animation:cnl-agenttool 1.2s ease-in-out infinite}.cnl-handoff-layer{pointer-events:none}.cnl-handoff-line{fill:none;stroke:#bd9c65;stroke-width:1.4;stroke-dasharray:3 4;opacity:.7;animation:cnl-handofffade 2.8s both}.cnl-handoff-envelope rect{fill:#fff6d9;stroke:#aa8b55;stroke-width:.8}.cnl-handoff-envelope path{fill:none;stroke:#aa8b55;stroke-width:.7}.cnl-handoff-envelope{opacity:.95}
    .cnl-agent.is-walking .cnl-walk-sprite{animation:cnl-walkbob .25s ease-in-out infinite alternate;transform-origin:0 -7px}.cnl-agent.is-walking .cnl-stride{display:block}.cnl-stride{display:none;fill:none;stroke:#485c60;stroke-width:2;stroke-linecap:round}.cnl-stride-one{animation:cnl-stepone .3s ease-in-out infinite alternate}.cnl-stride-two{animation:cnl-steptwo .3s ease-in-out infinite alternate}.cnl-agent.is-walking .cnl-role-tool{display:none}.cnl-agent.is-delivering .cnl-agent-card{fill:#fff0ca;stroke:#b88e47}.cnl-agent .cnl-carry-document{display:none;fill:#fff3d0;stroke:#ac8a50;stroke-width:.8}.cnl-agent.is-carrying .cnl-carry-document{display:block}.cnl-agent-motion-text{font-size:6px!important;fill:#8f703a!important;font-weight:750!important}
    .cnl-human{cursor:pointer;outline:none}.cnl-human-halo-static{fill:#f0c165;opacity:.12;stroke:#c28b43;stroke-width:1}.cnl-human-person{pointer-events:none}.cnl-human-card{fill:#fff6e3;stroke:#c19a64;stroke-width:.8}.cnl-human-name{font-size:7px;fill:#805d31;font-weight:800}.cnl-human-type{font-size:5px;fill:#a1773c;font-weight:700}.cnl-human-state{font-size:5.5px;fill:#8a795f}.cnl-human:hover .cnl-human-card,.cnl-human:focus-visible .cnl-human-card,.cnl-human.is-selected .cnl-human-card{stroke:#9f692a;stroke-width:1.6}.cnl-human.is-awaiting .cnl-human-halo-static{animation:cnl-humanpulse 1.8s ease-in-out infinite;opacity:.45}.cnl-human.is-handoff .cnl-human-card{fill:#ffe9b2;stroke:#bb8735}.cnl-delivery-feedback{pointer-events:none}.cnl-delivery-feedback rect{fill:#fff8df;stroke:#b2955c;stroke-width:.9}.cnl-delivery-title{font-size:8px;fill:#85602f;font-weight:800}.cnl-delivery-summary{font-size:6.5px;fill:#776954}.cnl-delivery-path{fill:none;stroke:#cba769;stroke-width:1.4;stroke-dasharray:2 5;opacity:.45;pointer-events:none}
    @keyframes cnl-walkbob{from{transform:translateY(0) rotate(-2deg)}to{transform:translateY(-1.7px) rotate(2deg)}}@keyframes cnl-stepone{from{transform:translateX(-2px)}to{transform:translateX(2px)}}@keyframes cnl-steptwo{from{transform:translateX(2px)}to{transform:translateX(-2px)}}
    .cnl-human-approval{display:none;cursor:pointer;outline:none}.cnl-human-approval.is-requesting{display:block}.cnl-human-halo{fill:#f0c165;stroke:#bd8536;stroke-width:1.2;opacity:.35;animation:cnl-humanpulse 1.8s ease-in-out infinite}.cnl-human-ring{fill:none;stroke:#e0a248;stroke-width:2.2;stroke-dasharray:3 3}.cnl-human-approval rect{fill:#fff4d2;stroke:#c79443;stroke-width:1}.cnl-human-approval text{fill:#996623;font-size:10px;font-weight:800}.cnl-human-approval .cnl-human-sub{font-size:6px;font-weight:600;fill:#b28a4b}.cnl-human-approval:hover rect,.cnl-human-approval:focus-visible rect{stroke:#9f6621;stroke-width:2}@keyframes cnl-humanpulse{50%{opacity:.62;r:39}}
    @keyframes cnl-agenttool{50%{transform:translateY(-2px) rotate(9deg)}}@keyframes cnl-handofffade{0%{opacity:0}12%,74%{opacity:.7}100%{opacity:0}}
    @keyframes cnl-datastream{to{stroke-dashoffset:-268}}@keyframes cnl-faultpulse{0%,100%{opacity:.03;r:24}50%{opacity:.16;r:30}}@keyframes cnl-rotate{to{transform:rotate(360deg)}}@keyframes cnl-ledblink{from{opacity:.4}to{opacity:1}}@keyframes cnl-agentpop{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes cnl-toolpulse{50%{fill:#c7e2ad}}
    .cnl-office-scene .cnl-room-title{fill:#294c47;font-weight:800;letter-spacing:.3px}.cnl-office-scene .cnl-room-en{font-size:6.8px;fill:#81968c;letter-spacing:1.05px}.cnl-office-scene .cnl-node-label rect{fill:#fffef9;stroke:#abc1b3;stroke-width:.75}.cnl-office-scene .cnl-node-label text{fill:#3f6459;font-size:7.6px;letter-spacing:.15px}.cnl-office-scene .cnl-cable-under{stroke:#fffef9;stroke-width:6;opacity:.95}.cnl-office-scene .cnl-cable{stroke:#68b7aa;stroke-width:1.7;opacity:.65}.cnl-office-scene .cnl-packet{stroke:#e7fff7;stroke-width:2.3;stroke-dasharray:7 138;filter:drop-shadow(0 0 2px #63c9b1)}
    .cnl-agent .cnl-ai-aura{fill:#71d8c0;stroke:#399f8b;stroke-width:.75;opacity:.10}.cnl-agent .cnl-agent-ground{fill:#def9ed;stroke:#55ac94;stroke-width:1;opacity:.9}.cnl-agent-ground-grid{fill:none;stroke:#8bcab4;stroke-width:.5;opacity:.7}.cnl-agent .cnl-agent-card{fill:#f5fff9;stroke:#7abca5;stroke-width:.8;stroke-dasharray:none}.cnl-agent .cnl-agent-card-stripe{stroke:#2d9f83;stroke-width:2;stroke-linecap:round}.cnl-agent .cnl-agent-name{fill:#244f46;font-size:7px;font-weight:800}.cnl-agent .cnl-agent-type{fill:#2c917a;font-size:4.8px;letter-spacing:.25px}.cnl-agent .cnl-agent-state{fill:#587d6d;font-size:5.7px}.cnl-agent .cnl-config-dot{stroke:#6ba78d;fill:#effcf4;stroke-width:.7}.cnl-agent.is-configured .cnl-config-dot{fill:#329a7d;stroke:#329a7d}.cnl-agent-headset{fill:none;stroke:#368c81;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}.cnl-agent-headset rect{fill:#d9fbef;stroke:#367e74;stroke-width:.7}.cnl-agent-headset circle{fill:#48b399;stroke:none}.cnl-ai-badge rect{fill:#d5fff1;stroke:#329f84;stroke-width:.6}.cnl-ai-badge path{fill:none;stroke:#2e8c76;stroke-width:.65;stroke-linecap:round}.cnl-ai-badge circle{fill:#2e8c76}.cnl-agent .cnl-pose-seated{display:none}.cnl-agent.is-seated:not(.is-walking):not(.is-delivering) .cnl-pose-standing{display:none}.cnl-agent.is-seated:not(.is-walking):not(.is-delivering) .cnl-pose-seated{display:block}.cnl-agent.is-working .cnl-ai-aura{fill:#9cf0d1;opacity:.24;stroke:#2a9f80}.cnl-agent.is-working .cnl-agent-card{stroke:#3b9e82}.cnl-agent.is-unassigned{opacity:.64}
    .cnl-human .cnl-human-halo-static{fill:#edbd74;stroke:#ba955a;stroke-width:.6;opacity:.12}.cnl-human-ground{fill:#fff4db;stroke:#c8a264;stroke-width:.9}.cnl-human-identity>circle:first-child{fill:#fff5df;stroke:#b98b4c;stroke-width:.8}.cnl-human-identity>circle:nth-child(2){fill:#ab7b3e}.cnl-human-identity path{fill:none;stroke:#ab7b3e;stroke-width:1;stroke-linecap:round}.cnl-human .cnl-human-card{fill:#fff9ec;stroke:#c5a66f;stroke-width:.8}.cnl-human-card-stripe{fill:none;stroke:#bb8b47;stroke-width:2;stroke-linecap:round}.cnl-human .cnl-human-name{fill:#6f542c;font-size:7px}.cnl-human .cnl-human-type{fill:#a1783b;font-size:4.8px}.cnl-human .cnl-human-state{fill:#92764d;font-size:5.5px}.cnl-carry-document{filter:drop-shadow(1px 2px 1px #245a4940)}.cnl-agent .cnl-carry-document{fill:#f4fff9;stroke:#3d9c80}
    .cnl-ambient-props{pointer-events:none}.cnl-ambient-cup,.cnl-ambient-tablet{opacity:0}
    :is(.cnl-agent,.cnl-human,.cnl-presence)[data-ambient="sip"] .cnl-ambient-cup,.cnl-agent[data-ambient="typing"] .cnl-ambient-tablet{animation:cnl-ambient-prop var(--ambient-duration,3200ms) ease-in-out var(--ambient-delay,0ms) 1 both}
    :is(.cnl-agent,.cnl-human,.cnl-presence)[data-ambient="wave"] .cnl-person-face-neutral{display:none}:is(.cnl-agent,.cnl-human,.cnl-presence)[data-ambient="wave"] .cnl-person-face-happy{display:block}
    .cnl-position[data-ambient="wave"]{--position-neutral:none;--position-happy:block}
    .cnl-position[data-ambient="wave"] .cnl-position-wave{display:none}
    @keyframes cnl-ambient-prop{0%,100%{opacity:0}20%,80%{opacity:1}}
    @keyframes cnl-ambient-sip{0%,100%{transform:rotate(0deg)}24%,72%{transform:rotate(-105deg)}42%,58%{transform:rotate(-112deg)}}
    @keyframes cnl-ambient-look{0%,100%{transform:rotate(0deg)}25%,68%{transform:rotate(calc(var(--ambient-direction,1)*8deg)) translateX(1.4px)}}
    @keyframes cnl-ambient-nod{0%,100%{transform:rotate(0deg) translateY(0)}25%,57%{transform:rotate(7deg) translateY(1px)}40%,75%{transform:rotate(-3deg) translateY(0)}}
    @keyframes cnl-ambient-wave{0%,100%{transform:rotate(0deg)}20%,62%{transform:rotate(-130deg)}34%,48%{transform:rotate(-106deg)}41%,55%{transform:rotate(-144deg)}}
    @keyframes cnl-ambient-type-left{0%,100%{transform:rotate(0deg)}20%,80%{transform:rotate(-47deg)}35%,62%{transform:rotate(-57deg)}}
    @keyframes cnl-ambient-type-right{0%,100%{transform:rotate(0deg)}20%,80%{transform:rotate(47deg)}46%,72%{transform:rotate(57deg)}}
    @keyframes cnl-post-arm-wave{0%,100%{transform:rotate(0deg)}22%,70%{transform:rotate(-46deg)}34%,54%{transform:rotate(-65deg)}44%,64%{transform:rotate(-37deg)}}
    @keyframes cnl-post-look{0%,100%{transform:rotate(0deg) translateX(0)}25%,70%{transform:translateX(calc(var(--ambient-direction,1)*1.5px)) rotate(calc(var(--ambient-direction,1)*8deg))}45%{transform:translateX(calc(var(--ambient-direction,1)*2px)) rotate(calc(var(--ambient-direction,1)*11deg))}}
    @keyframes cnl-post-nod{0%,100%{transform:translateY(0) rotate(0deg)}22%,58%{transform:translateY(1.5px) rotate(7deg)}38%,74%{transform:translateY(-.6px) rotate(-4deg)}}
    @keyframes cnl-post-type-left{0%,100%{transform:rotate(0deg)}18%,46%,72%{transform:rotate(-9deg) translateY(-.5px)}30%,58%,84%{transform:rotate(5deg)}}
    @keyframes cnl-post-type-right{0%,100%{transform:rotate(0deg)}25%,53%,79%{transform:rotate(9deg) translateY(-.5px)}38%,66%,88%{transform:rotate(-5deg)}}
    @keyframes cnl-post-wave{0%,100%{transform:rotate(0deg)}24%,60%{transform:rotate(-16deg)}34%,72%{transform:rotate(12deg)}45%{transform:rotate(-10deg)}}
    @keyframes cnl-stretch-left{0%,100%{transform:rotate(0deg)}25%,65%{transform:rotate(-65deg)}42%{transform:rotate(-76deg)}}
    @keyframes cnl-stretch-right{0%,100%{transform:rotate(0deg)}25%,65%{transform:rotate(65deg)}42%{transform:rotate(76deg)}}
    @keyframes cnl-stretch-head{0%,100%{transform:translateY(0) rotate(0deg)}30%,65%{transform:translateY(-1px) rotate(-8deg)}}
    @keyframes cnl-settle-body{0%,100%{transform:translate(0,0) rotate(0deg)}24%{transform:translate(-1px,.7px) rotate(-3deg)}54%{transform:translate(1px,-.5px) rotate(2deg)}78%{transform:translate(0,.5px) rotate(-1deg)}}
    @media(prefers-reduced-motion:reduce){.cnl-office-scene *{animation:none!important;transition:none!important}}
    .cnl-presence{cursor:pointer;outline:none}.cnl-presence-name{font-size:7px;fill:#4a5149;font-weight:650;paint-order:stroke;stroke:#faf8ef;stroke-width:2.6;stroke-linejoin:round}.cnl-presence[data-current="true"] .cnl-presence-name{fill:#8b4835;font-weight:800}.cnl-presence:hover .cnl-presence-name,.cnl-presence:focus-visible .cnl-presence-name{text-decoration:underline}.cnl-presence-body{transform-origin:0 -12px}
    .cnl-person-face-happy{display:none}.cnl-presence[data-greeting="human"] .cnl-person-face-neutral{display:none}.cnl-presence[data-greeting="human"] .cnl-person-face-happy{display:block}
    .cnl-greeting-layer{pointer-events:none}.cnl-greeting-surface{fill:var(--dialog-paper,#fffdf6);stroke:var(--dialog-line,#d3ddcd);stroke-width:.85;stroke-linejoin:round}.cnl-greeting-bubble[data-kind="human"] .cnl-greeting-surface{stroke:#dfcdbd}.cnl-greeting-bubble text{font-size:13px;fill:var(--dialog-ink,#29483d);font-weight:650;letter-spacing:.1px}.cnl-greeting-detail{fill:var(--dialog-accent,#3c7160);opacity:.7}.cnl-greeting-bubble[data-kind="human"] .cnl-greeting-detail{fill:#a46f55}.cnl-greeting-layer[data-visible="true"] .cnl-greeting-bubble{animation:cnl-greeting-enter .16s ease-out both}.cnl-greeting-icon{stroke-linecap:round;stroke-linejoin:round;fill:none}
    .cnl-department-tooltip-surface{fill:var(--dialog-paper,#fffdf6);stroke:var(--dialog-line,#d3ddcd);stroke-width:1}.cnl-department-tooltip-title{font-size:14px;fill:var(--dialog-ink,#29483d);font-weight:700}.cnl-department-tooltip-total{font-size:14px;fill:var(--dialog-ink,#29483d);font-weight:650}.cnl-department-tooltip-roles{font-size:12px;fill:var(--dialog-muted,#687565);font-weight:500}
    @keyframes cnl-greeting-enter{from{opacity:0;translate:0 3px}to{opacity:1;translate:0 0}}
    .cnl-node-layer .cnl-node-label{opacity:0}.cnl-node-layer .cnl-node:is(:hover,:focus-visible,.is-selected,[data-status="offline"],[data-status="warning"]) .cnl-node-label{opacity:1}
    .cnl-node[data-department-hover="true"] .cnl-room-hover-surface{opacity:.32}.cnl-node[data-department-hover="true"] .cnl-room-hover-outline{opacity:1}.cnl-department-title{fill:var(--dialog-ink,#29483d);font-weight:750;letter-spacing:.3px}.cnl-department-count{font-size:13px;fill:#647a6b;font-weight:550}.cnl-node:is(:hover,:focus-visible,.is-selected) .cnl-department-title{fill:#24795e}.cnl-node:is(:focus-visible,.is-selected) .cnl-department-room>rect:first-of-type{stroke:#659b7e;stroke-width:3}.cnl-team-zone{cursor:pointer;outline:none}.cnl-team-zone:is(:hover,:focus-visible)>rect{stroke:#6c9a82;stroke-width:1.8}.cnl-team-title{font-size:15px;fill:#355f4d;font-weight:700}.cnl-team-count{font-size:11px;fill:#6a8272}.cnl-position{cursor:pointer;outline:none}.cnl-position-person{display:var(--position-person-display,block)}.cnl-position-rank text{font-size:9px;fill:#6b755e;font-weight:650}.cnl-position-caption{display:none;pointer-events:none}.cnl-position-caption rect{fill:var(--dialog-paper,#fffdf6);stroke:var(--dialog-line,#d3ddcd);stroke-width:.7}.cnl-position-caption text{font-size:10px;fill:var(--dialog-ink,#29483d);font-weight:600}.cnl-person-card,.cnl-presence-name{display:none}.cnl-name-layer{pointer-events:none}.cnl-name-scale{transform:scale(var(--name-scale,1));transform-origin:0 0}.cnl-name-text{font-size:9px;fill:#395b4c;font-weight:550;paint-order:stroke;stroke:#faf8ed;stroke-width:2.2px;stroke-linejoin:round}.cnl-position-wave{display:none;pointer-events:none}.cnl-position[data-greeting="human"]{--position-neutral:none;--position-happy:block;--position-arm:none}.cnl-position[data-greeting="human"] .cnl-position-wave{display:block}.cnl-common-area-title{font-size:20px;fill:#6b806d;font-weight:650}.cnl-office-company{font-size:13px;fill:#566e5f;font-weight:650}.cnl-office-total{font-size:12px;fill:#6b806d;font-weight:550}
  </style>

  <g class="cnl-world">
    <g class="cnl-campus-floor">${renderOrganizationFloor({uid,use,seated,plant})}</g>
    <g class="cnl-local-floor" style="display:none"></g><g class="cnl-local-seats"></g>
    <g class="cnl-links">${linkMarkup}</g>
    <g class="cnl-node-layer">${hotspots}</g>
    <g class="cnl-handoff-layer"></g><g class="cnl-human-layer"></g><g class="cnl-navigation-target" pointer-events="none" aria-hidden="true" style="display:none"><circle r="9" fill="#fffdf4" fill-opacity=".7" stroke="#3d816d" stroke-width="1.5"/><circle r="3" fill="#3d816d"/></g><g class="cnl-presence-layer"></g>
    <g class="cnl-human-approval" transform="translate(${HUMAN_EMPLOYEES[0].x} ${HUMAN_EMPLOYEES[0].y-21})" tabindex="0" role="button" aria-label="你，需要审批" aria-hidden="true"><circle class="cnl-human-halo" r="34"/><circle class="cnl-human-ring" r="27"/><g transform="translate(-51 -72)"><rect width="102" height="31" rx="9"/><text x="51" y="13" text-anchor="middle">需要你审批</text><text class="cnl-human-sub" data-approval-human-name="" x="51" y="24" text-anchor="middle">你</text></g></g><g class="cnl-agent-layer"></g><g class="cnl-name-layer" aria-hidden="true" pointer-events="none"></g><g class="cnl-greeting-layer" aria-hidden="true" style="display:none"></g>
  </g>
  </svg>`;

  const svg = container.querySelector('svg');
  let ambientRect=container.getBoundingClientRect?.()||svg.getBoundingClientRect?.()||{width:OFFICE_WORLD.width,height:OFFICE_WORLD.height};
  // Inline the moving characters so limb transforms can follow the actual walk cycle.
  // Fixed desk occupants keep lightweight reusable symbols.
  const avatarArtwork={person:svg.querySelector(`#${uid}-person`).innerHTML,seated:svg.querySelector(`#${uid}-seated`).innerHTML};
  const ambientProps='<g class="cnl-ambient-props" aria-hidden="true"><g class="cnl-ambient-cup" transform="translate(12 -28)"><path d="M2-3Q9-3 7 1Q6 3 3 1" fill="none" stroke="#8c7051" stroke-width=".8"/><rect x="-3" y="-4" width="7" height="7" rx="2" fill="#f3ddad" stroke="#8c7051" stroke-width=".7"/><path d="M-1-5Q-3-8-1-10" fill="none" stroke="#c4ad84" stroke-width=".6"/></g><g class="cnl-ambient-tablet" transform="translate(0 -15)"><rect x="-8" y="-6" width="16" height="12" rx="2" fill="#435f61" stroke="#335151" stroke-width=".8"/><rect x="-6.2" y="-4.2" width="12.4" height="7.5" rx=".8" fill="#b5e0ce"/><path d="M-4-2H3M-4 .2H0" stroke="#eef9e9" stroke-width=".7"/><circle cy="4.5" r=".7" fill="#bdd6ca"/></g></g>';
  const avatar=(shirt,hair,{sitting=false,scale=.56,standingOffset=-22,appearance=null,chair=true,resting=false,back=sitting}={})=>`<g class="${sitting?'cnl-pose-seated cnl-seated':'cnl-pose-standing'}"${appearance?` data-outfit="${appearance.outfitId}" data-synthetic="${appearance.synthetic}"`:''} transform="translate(0 ${sitting?0:standingOffset}) scale(${scale})" style="${appearance?employeeAppearanceStyle(appearance):`--shirt:${esc(shirt)};--hair:${esc(hair)}`};--chair-display:${chair?'block':'none'};--typing-display:${resting?'none':'block'};--resting-display:${resting?'block':'none'};--front-facing:${back?'none':'block'};--back-facing:${back?'block':'none'}">${avatarArtwork[sitting?'seated':'person']}</g>`;
  const teamElements=new Map([...svg.querySelectorAll('[data-team]')].map(el=>[el.dataset.team,el]));
  const displayedPositions=new Map();
  const positionElements=new Map([...svg.querySelectorAll('[data-position]')].map(el=>[el.dataset.position,el]));
  const positionVariants=createOfficeSVGVariants(document),positionTransitions=new Map();
  let didSyncPositions=false,positionWarmup=0,positionWarmupIndex=0;
  const densePositions=OFFICE_ROOMS.filter(room=>room.seats.some(post=>!post.overviewVisible)).flatMap(room=>room.seats);
  // A physical facility and a projected hotspot may share one business ID.
  // Keep each DOM surface interactive instead of dropping an earlier copy.
  const nodeElements = [...svg.querySelectorAll('[data-node]')];
  const campusFloor=svg.querySelector('.cnl-campus-floor'),localFloor=svg.querySelector('.cnl-local-floor'),localSeats=svg.querySelector('.cnl-local-seats');
  const positionParents=new Map([...positionElements].map(([id,el])=>[id,el.parentNode||el.parent]));
  const campusLayers=[campusFloor,svg.querySelector('.cnl-links'),svg.querySelector('.cnl-node-layer'),svg.querySelector('.cnl-handoff-layer'),svg.querySelector('.cnl-agent-layer')];
  const deviceElements = new Map([...svg.querySelectorAll('[data-device]')].map(el => [el.dataset.device, el]));
  const links = [...svg.querySelectorAll('.cnl-link')];
  let approvalHumanId='owner';
  const humanApproval=svg.querySelector('.cnl-human-approval');humanApproval.addEventListener('click',e=>{e.stopPropagation();if(!presenceState.enabled&&!localTeamId)onSelectHuman(approvalHumanId);});humanApproval.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();if(!presenceState.enabled&&!localTeamId)onSelectHuman(approvalHumanId);}});
  const agentLayer = svg.querySelector('.cnl-agent-layer');
  const handoffLayer = svg.querySelector('.cnl-handoff-layer');
  const humanLayer = svg.querySelector('.cnl-human-layer');
  const humanElements = new Map();
  const humanSignatures=new Map();
  const humanPositions = new Map(HUMAN_EMPLOYEES.map(h => [h.id,{x:h.x,y:h.y}]));
  const presenceLayer=svg.querySelector('.cnl-presence-layer');
  const greetingLayer=svg.querySelector('.cnl-greeting-layer');
  const nameLayer=svg.querySelector('.cnl-name-layer'),nameElements=new Map();nameLayer.setAttribute('aria-hidden','false');let nameScale='';
  const presenceElements=new Map(),localPresencePoints=new Map();let presenceState={enabled:false,people:[]},presenceFrame=0,presenceHiddenAt=null,lastPresenceStep=null,presenceBatchDepth=0,lastPresenceValue={};
  const navigationMarker=svg.querySelector('.cnl-navigation-target');let navigationTarget=null;
  const compactRoomScales=new Map(OFFICE_ROOMS.filter(room=>room.seats.some(post=>!post.overviewVisible)).map(room=>[room.id,Math.min(...room.seats.map(post=>post.scale))]));
  const agentElements = new Map();
  const agentPositions = new Map();
  const agentSignatures = new Map();
  const deliveryQueue = createDeliveryQueue();
  const handoffTimers = new Set();
  const desiredPositions = new Map();
  const motions = new Map();
  const agentState = new Map();
  const motionPreference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion=motionPreference?.matches || false;
  let motionFrame = 0;
  let motionEpoch = 0;
  let activeRunId,runIsActive=false;
  let hasUpdated = false;
  let selectedHuman = null;
  let scale = 1,focusedDepartmentId=null,focusedTeamId=null,cameraOwner='automatic',localTeamId=null,localFitScale=1,hoveredDepartmentId=null,departmentScope=null,departmentFitScale=1;
  let panX = 0;
  let panY = 0;
  let selected = null;
  let selectedAgent = null;
  let drag = null,floorClickTimer=null;
  const touches=new Map(),inputDisposers=[];
  let touchGesture=null,nativeGesture=null;
  let suppressClickUntil = 0;
  let viewFrame = 0;
  let motionUntil = 0;
  let destroyed = false,active=true,inactiveAt=null,ambient=null;
  let cameraMotionFrame=0,hoveredObject=null,wheelAnchor=null,lastViewBox=INITIAL_VIEW_BOX,localTransitionFrame=0,lastManualCameraAt=-Infinity,pendingPresenceFocus=null;
  let greetingElement=null,greetingAnimation=null,departmentHint=null,hintScaleBase=1,hintBounds={half:64,top:-88,bottom:-37};
  const feedbackAnimations=new WeakMap();
  const viewTween=createViewTween({read:()=>({scale,panX,panY}),write:value=>{({scale,panX,panY}=value);if(wheelAnchor){panX=wheelAnchor.world.x-WORLD_CX-wheelAnchor.offsetX/scale;panY=wheelAnchor.world.y-WORLD_CY-wheelAnchor.offsetY/scale;}applyView();}});
  function beginManualCamera(kind){pendingPresenceFocus=null;lastManualCameraAt=performance.now();onCameraIntent('manual');if(cameraOwner!==kind)stopCamera();cameraOwner=kind;focusedDepartmentId=null;focusedTeamId=null;}
  function animateView(patch,anchor=null,{manual=false}={}){onLeaveBulletin();if(!manual)cameraOwner='automatic';if(!officeCameraChanged(viewTween.target,{...viewTween.target,...patch}))return viewTween.target;wheelAnchor=anchor?{...anchor,offsetX:(anchor.world.x-WORLD_CX-panX)*scale,offsetY:(anchor.world.y-WORLD_CY-panY)*scale}:null;const next=viewTween.start({...viewTween.target,...patch},{immediate:reducedMotion||!active,duration:manual?160:520,easing:manual?'out':'smooth'});if(active&&viewTween.active&&!cameraMotionFrame)cameraMotionFrame=requestAnimationFrame(tickCamera);if(!viewTween.active)wheelAnchor=null;return next;}
  function tickCamera(time){cameraMotionFrame=0;if(destroyed||!active||document.hidden)return;viewTween.tick(time);if(viewTween.active)cameraMotionFrame=requestAnimationFrame(tickCamera);else {wheelAnchor=null;if(pendingPresenceFocus){const id=pendingPresenceFocus;pendingPresenceFocus=null;ensurePresenceVisible(id,{immediate:true});}}}
  function stopCamera(){pendingPresenceFocus=null;wheelAnchor=null;viewTween.cancel();cancelAnimationFrame(cameraMotionFrame);cameraMotionFrame=0;}
  function objectFeedback(element,press=false){if(!element?.animate||reducedMotion||destroyed)return;feedbackAnimations.get(element)?.cancel();feedbackAnimations.set(element,element.animate([{translate:'0 0',filter:'brightness(1)'},{translate:press?'0 1px':'0 -2px',filter:'brightness(1.08)'},{translate:'0 0',filter:'brightness(1)'}],{duration:press?250:320,easing:'cubic-bezier(.2,.7,.2,1)'}));}
  function stopGreetingWave(){greetingAnimation?.cancel();greetingAnimation=null;}
  function clearGreeting(){
    stopGreetingWave();
    if(greetingElement){delete greetingElement.dataset.greeting;greetingElement.removeAttribute?.('aria-describedby');}
    departmentHint?.element.removeAttribute?.('aria-describedby');departmentHint=null;
    greetingElement=null;greetingLayer.style.display='none';greetingLayer.dataset.visible='false';greetingLayer.setAttribute('aria-hidden','true');greetingLayer.innerHTML='';ambient?.refresh();
  }
  function greetingPerson(target){
    const element=target?.closest?.('[data-agent], [data-human], [data-position]');
    if(!element)return null;
    if(element.dataset.position&&positionElements.get(element.dataset.position)===element)return element.dataset.visible!=='false'&&element.dataset.presenceRepresented!=='true'&&ORGANIZATION_POSITION_META[element.dataset.position]?.occupantVisible?element:null;
    if(element.dataset.agent&&agentElements.get(element.dataset.agent)===element)return element;
    // Only actual signed-in people greet in ERP, never hidden lab representatives.
    const id=element.dataset.human;
    return presenceState.enabled&&presenceElements.get(id)===element&&presenceMotion.entries.has(id)?element:null;
  }
  function cacheHintScale(){const matrix=svg.getScreenCTM(),unit=matrix?Math.hypot(matrix.a,matrix.b):0,native=Number(globalThis.visualViewport?.scale)||1;if(unit>0)hintScaleBase=scale/(unit*native);}
  function syncGreetingPoint(){
    if(!greetingElement&&!departmentHint)return;
    const point=departmentHint?.point||(greetingElement.dataset.position?displayedPositions.get(greetingElement.dataset.position):greetingElement.dataset.agent?agentPositions.get(greetingElement.dataset.agent):humanPositions.get(greetingElement.dataset.human));
    if(!point){clearGreeting();return;}
    const factor=hintScaleBase/scale;greetingLayer.setAttribute('transform',`translate(${point.x} ${point.y}) scale(${factor})`);
    const left=WORLD_CX+panX-OFFICE_WORLD.width/scale/2,right=left+OFFICE_WORLD.width/scale,top=WORLD_CY+panY-OFFICE_WORLD.height/scale/2,bottom=top+OFFICE_WORLD.height/scale;
    const dx=Math.max(left+(hintBounds.half+8)*factor,Math.min(right-(hintBounds.half+8)*factor,point.x))-point.x;
    const dy=Math.max(top+(-hintBounds.top+8)*factor,Math.min(bottom-(hintBounds.bottom+8)*factor,point.y))-point.y;
    const hint=greetingLayer.querySelector(departmentHint?'.cnl-department-tooltip':'.cnl-greeting-bubble');hint?.setAttribute('transform',`translate(${dx/factor} ${dy/factor})`);
  }
  function showDepartmentHint(element,room){
    if(destroyed||document.hidden||drag||localTeamId){clearGreeting();return;}if(departmentHint?.element===element)return;
    clearGreeting();cacheHintScale();hintBounds={half:116,top:-82,bottom:0};departmentHint={element,point:{x:room.x+room.w/2,y:room.y+Math.min(room.h*.52,112)}};
    const roles=[['chairman','董事长'],['manager','经理'],['head','部长'],['staff','员工']].filter(([key])=>room.roleCounts[key]).map(([key,label])=>`${label} ${room.roleCounts[key]}`).join(' · ');
    element.setAttribute('aria-describedby',`${uid}-greeting`);greetingLayer.innerHTML=`<g class="cnl-department-tooltip" id="${uid}-greeting" role="tooltip"><rect class="cnl-department-tooltip-surface" x="-116" y="-82" width="232" height="82" rx="12"/><text class="cnl-department-tooltip-title" x="-101" y="-58">${esc(room.title)}</text><text class="cnl-department-tooltip-total" x="-101" y="-35">${room.headcount} 人</text><text class="cnl-department-tooltip-roles" x="-101" y="-15">${esc(roles)}</text></g>`;
    greetingLayer.style.display='';greetingLayer.dataset.visible='true';greetingLayer.setAttribute('aria-hidden','false');syncGreetingPoint();ambient?.refresh();
  }
  function departmentAt(point){return point&&OFFICE_ROOMS.find(room=>point.x>=room.x&&point.x<=room.x+room.w&&point.y>=room.y&&point.y<=room.y+room.h)?.id||null;}
  function departmentForEvent(event){
    const target=event?.target,el=target?.closest?.('[data-position],[data-agent],[data-human],[data-node],[data-team],[data-department]');
    const id=el?.dataset?.position;if(id)return ORGANIZATION_POSITION_META[id]?.departmentId||null;
    if(el?.dataset?.team)return OFFICE_ROOMS.find(room=>room.teamZones.some(team=>team.id===el.dataset.team))?.id||null;
    if(ROOM_IDS.has(el?.dataset?.node))return el.dataset.node;
    if(ROOM_IDS.has(el?.dataset?.department))return el.dataset.department;
    if(el?.dataset?.agent)return departmentAt(agentPositions.get(el.dataset.agent))||AGENT_META[el.dataset.agent]?.departmentId||null;
    if(el?.dataset?.human){const person=presenceMotion.entries.get(el.dataset.human);return departmentAt(person?.point||humanPositions.get(el.dataset.human))||person?.person.nodeId||HUMAN_EMPLOYEES.find(person=>person.id===el.dataset.human)?.nodeId||null;}
    return Number.isFinite(event?.clientX)&&Number.isFinite(event?.clientY)?departmentAt(worldPoint(event.clientX,event.clientY)):null;
  }
  function setHoveredDepartment(id){
    const next=!drag?.moved&&!touchGesture&&!localTeamId&&ROOM_IDS.has(id)?id:null;if(next===hoveredDepartmentId)return false;
    hoveredDepartmentId=next;svg.dataset.hoverDepartment=next||'';onDepartmentHover(next);
    for(const el of nodeElements)if(ROOM_IDS.has(el.dataset.node))el.dataset.departmentHover=String(el.dataset.node===next);
    return true;
  }
  function departmentZoom(next,direction){
    if(direction<0&&departmentScope&&next<=departmentFitScale*OFFICE_DEPARTMENT_CAMERA_POLICY.exitRatio){resetInput();resetOfficeView();return true;}
    if(direction>0&&!localTeamId&&hoveredDepartmentId&&departmentScope!==hoveredDepartmentId&&next>=OFFICE_DEPARTMENT_CAMERA_POLICY.enterScale){const room=OFFICE_ROOMS.find(room=>room.id===hoveredDepartmentId);resetInput();focusedDepartmentId=room.id;focusedTeamId=null;focusRegion(room);return true;}
    return false;
  }
  function showObjectHint(event){const person=greetingPerson(event.target);if(person){showGreeting(person);return;}const element=event.target?.closest?.('[data-node]'),room=OFFICE_ROOMS.find(room=>room.id===element?.dataset.node);if(room)showDepartmentHint(element,room);else clearGreeting();}

  function showGreeting(element){
    if(destroyed||document.hidden||drag||localTeamId&&element?.dataset?.agent){clearGreeting();return;}
    if(element===greetingElement)return;
    clearGreeting();if(!element||element.dataset.position&&element.dataset.presenceRepresented==='true')return;
    const greeting=greetingForPerson({virtual:!!element.dataset.agent}),robot=greeting.kind==='robot',half=robot?64:59;cacheHintScale();hintBounds={half,top:-88,bottom:-37};
    const icon=robot?'<rect x=".65" y=".65" width="30.7" height="30.7" rx="11" fill="#eef2e6" stroke="#d3ddcd" stroke-width="1.1"/><path d="M16 8V4.5m-12 11v5m24-5v5" stroke="#709480" stroke-width="1.5" stroke-linecap="round"/><circle cx="16" cy="4" r="1.55" fill="#ba8267"/><rect x="6" y="8" width="20" height="18" rx="6" fill="#fffdf6" stroke="#5f8875" stroke-width="1.2"/><path d="M9.8 15.4q1.7-2.8 3.4 0m5.6 0q1.7-2.8 3.4 0" stroke="#3c7160" stroke-width="1.6" stroke-linecap="round"/><path d="M11.8 20q4.2 4.4 8.4 0" fill="#e4edde" stroke="#3c7160" stroke-width="1.15" stroke-linecap="round"/><path d="M9 18.2h1.5m11 0H23" stroke="#bb9277" stroke-width="1.25" stroke-linecap="round"/>':'<rect x=".65" y=".65" width="30.7" height="30.7" rx="11" fill="#f6eadf" stroke="#dfcdbd" stroke-width="1.1"/><circle cx="16" cy="16" r="10.6" fill="#f0cfab"/><path d="M9.7 14q1.7-2.2 3.5 0m5.6 0q1.7-2.2 3.5 0" stroke="#71513f" stroke-width="1.55" stroke-linecap="round"/><path d="M11 18.6q5 5.8 10 0" fill="#fffdf6" stroke="#9b6651" stroke-width="1.15" stroke-linecap="round"/><circle cx="9.2" cy="17.5" r="1.45" fill="#d2947e" opacity=".6"/><circle cx="22.8" cy="17.5" r="1.45" fill="#d2947e" opacity=".6"/><path d="m25.2 5.8.8-1.6.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8Z" fill="#ba896c"/>';
    greetingElement=element;ambient?.refresh();element.dataset.greeting=greeting.kind;element.setAttribute('aria-describedby',`${uid}-greeting`);
    greetingLayer.innerHTML=`<g class="cnl-greeting-bubble" data-kind="${greeting.kind}" id="${uid}-greeting" role="tooltip"><path class="cnl-greeting-surface" d="M${-half+17}-88H${half-17}Q${half}-88 ${half}-71V-63Q${half}-46 ${half-17}-46H7L-5-37Q-8.5-34.4-8-39L-7-46H${-half+17}Q${-half}-46 ${-half}-63V-71Q${-half}-88 ${-half+17}-88Z"/><g class="cnl-greeting-icon cnl-greeting-icon-${greeting.kind}" transform="translate(${-half+8} -80) scale(.83)">${icon}</g><g class="cnl-greeting-detail" transform="translate(${-half+44} -76)"><circle r=".9"/><circle cx="4.5" r=".9"/><circle cx="9" r=".9"/></g><text x="${-half+44}" y="-59.5">${esc(greeting.text)}</text></g>`;
    greetingLayer.style.display='';greetingLayer.dataset.visible='true';greetingLayer.setAttribute('aria-hidden','false');syncGreetingPoint();
    const id=element.dataset.human,entry=presenceMotion.entries.get(id),arm=element.querySelector(element.dataset.position?'.cnl-position-wave':'.cnl-person-arm-right');
    if(!robot&&!reducedMotion&&!entry?.motion&&!deliveryQueue.locked(id)&&arm?.animate){
      greetingAnimation=arm.animate(element.dataset.position?[{transform:'rotate(0deg)',offset:0},{transform:'rotate(-14deg)',offset:.2},{transform:'rotate(12deg)',offset:.4},{transform:'rotate(-12deg)',offset:.6},{transform:'rotate(10deg)',offset:.8},{transform:'rotate(0deg)',offset:1}]:[{transform:'rotate(0deg)',offset:0},{transform:'rotate(-130deg)',offset:.27},{transform:'rotate(-108deg)',offset:.4},{transform:'rotate(-143deg)',offset:.53},{transform:'rotate(-110deg)',offset:.66},{transform:'rotate(-134deg)',offset:.78},{transform:'rotate(0deg)',offset:1}],{duration:920,easing:'ease-in-out',iterations:1});
    }
  }
  for(const [id,element]of positionElements){const select=event=>{event.stopPropagation();if(destroyed||element.dataset.visible==='false'||performance.now()<suppressClickUntil)return;cancelFloorClick();for(const [otherId,other]of positionElements){other.dataset.selected=String(otherId===id);other.setAttribute('aria-pressed',String(otherId===id));}const personHit=event.target?.closest?.('.cnl-position-person');if(personHit||event.key){onSelectPostEmployee(id);}else{const canonical=ORGANIZATION_POSITION_META[id];onSelectSeat(id,{x:canonical.x,y:canonical.y,nodeId:canonical.departmentId});}showGreeting(element);};element.addEventListener('click',select);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(event);}});}
  const presenceMotion=createOfficePresenceMotion({reducedMotion,onChange:entry=>setPresencePoint(entry)});
  function renderPresencePerson(element,person,{sitting=false,size=.66,atSeat=false}={}){
    const signature=JSON.stringify([person.name,person.title,person.current,person.color,person.hair,person.posture,person.seatId,person.outfitId,person.appearanceKey,sitting,size,atSeat]);if(element.dataset.signature===signature)return;
    if(element===greetingElement)stopGreetingWave();element.dataset.signature=signature;element.classList.toggle('is-seated',sitting);
    const ratio=size/.66;
    element.innerHTML=`<title>${esc(person.name)}${person.title?' · '+esc(person.title):''} · 在线员工</title><rect x="${-15*ratio}" y="${-40*ratio}" width="${30*ratio}" height="${54*ratio}" fill="transparent"/><g class="cnl-presence-body">${avatar(person.color,person.hair,{sitting,scale:size,standingOffset:-22*ratio,back:false,chair:!atSeat,resting:sitting&&!atSeat,appearance:employeeAppearance({id:person.appearanceKey||person.id,outfitId:person.outfitId})})}<g transform="scale(${ratio})">${ambientProps}${sitting?'':'<path d="M-2-18L0-12L2-18" fill="none" stroke="#f0e4d0" stroke-width=".8"/><rect x="-2" y="-12" width="4" height="5" rx=".7" fill="#f7f0df" stroke="#8b7966" stroke-width=".5"/>'}</g></g><text class="cnl-presence-name" y="13" text-anchor="middle">${esc(person.name.slice(0,9))}${person.name.length>9?'…':''}${person.current?' · 你':''}</text>`;
  }
  function setPresencePoint(entry){const el=presenceElements.get(entry.person.id);if(!el)return;const {point,sample,person}=entry,walking=!!entry.motion||localPresencePoints.get(person.id)?.moving===true,seat=person.seatId&&(displayedPositions.get(person.seatId)||ORGANIZATION_POSITION_META[person.seatId]),sitting=person.posture==='seated'&&!walking;
    const canonicalSeat=ORGANIZATION_POSITION_META[person.seatId||person.appearanceKey],sampledOut=sitting&&!person.current&&!localTeamId&&canonicalSeat&&!canonicalSeat.overviewVisible&&departmentScope!==canonicalSeat.departmentId;
    const visible=!sampledOut&&(!localTeamId||(sitting&&seat?seat.teamId===localTeamId:officePointInTeam(point,localTeamId)));el.style.display=visible?'':'none';el.setAttribute('aria-hidden',String(!visible));el.setAttribute('tabindex',visible?'0':'-1');
    const displayPoint=sitting&&seat?{x:seat.x,y:seat.y}:officeDisplayPoint(point,localTeamId),denseRoom=OFFICE_ROOMS.find(room=>compactRoomScales.has(room.id)&&room.teamZones.some(team=>point.x>=team.x&&point.x<=team.x+team.w&&point.y>=team.y&&point.y<=team.y+team.h));
    renderPresencePerson(el,person,{sitting,atSeat:!!(sitting&&seat),size:sitting&&seat?seat.scale*.6:localTeamId?.432:denseRoom?compactRoomScales.get(denseRoom.id)*.6:.66});
    el.setAttribute('transform',`translate(${displayPoint.x} ${displayPoint.y})`);humanPositions.set(person.id,{...displayPoint});el.dataset.walking=String(walking);el.dataset.x=displayPoint.x.toFixed(2);el.dataset.y=displayPoint.y.toFixed(2);
    if(el===greetingElement){if(entry.motion||deliveryQueue.locked(person.id))stopGreetingWave();syncGreetingPoint();}if(!presenceBatchDepth)syncNameLabels();
    const body=el.querySelector('.cnl-presence-body');if(body)body.style.transform=`translateY(${sample?.bob||0}px) rotate(${sample?.lean||0}deg)`;
    for(const [selector,sign]of[['.cnl-person-leg-left',1],['.cnl-person-leg-right',-1],['.cnl-person-arm-left',-.65],['.cnl-person-arm-right',.65]]){const limb=el.querySelector(selector);if(limb)limb.style.transform=`rotate(${(sample?.stride||0)*sign}deg)`;}
    if(person.current&&active&&!destroyed&&!document.hidden){const arrived=!localPresencePoints.has(person.id)&&(sample?.arrived===true||!!(reducedMotion&&!entry.motion&&entry.target&&Math.abs(point.x-entry.target.x)<.001&&Math.abs(point.y-entry.target.y)<.001)),key=`${person.id}:${point.x}:${point.y}:${walking}:${arrived}`;if(lastPresenceStep!==key){lastPresenceStep=key;onPresenceStep({point:{x:point.x,y:point.y},person:{...person},walking,arrived});}}
  }
  function withPresenceBatch(change){presenceBatchDepth++;try{return change();}finally{if(--presenceBatchDepth===0)syncNameLabels();}}
  function ensurePresenceFrame(){if(!presenceFrame&&active&&!destroyed&&!document.hidden&&presenceMotion.busy)presenceFrame=requestAnimationFrame(tickPresence);}
  function tickPresence(time){presenceFrame=0;if(destroyed||!active||document.hidden)return;withPresenceBatch(()=>presenceMotion.tick(time,{isPaused:id=>deliveryQueue.locked(id)}));onViewChange();ensurePresenceFrame();if(!presenceMotion.busy)ambient?.refresh();}
  function presenceVisibility(){if(!active)return;if(document.hidden){clearGreeting();if(cameraOwner==='automatic')viewTween.finish();resetInput();presenceHiddenAt=performance.now();cancelAnimationFrame(presenceFrame);presenceFrame=0;}else{if(presenceHiddenAt!==null)presenceMotion.shiftTime(performance.now()-presenceHiddenAt);presenceHiddenAt=null;ensurePresenceFrame();}}
  document.addEventListener?.('visibilitychange',presenceVisibility);
  function syncLegacyHumanVisibility(){
    const hidden=presenceState.enabled||!!localTeamId;humanLayer.style.display=hidden?'none':'';humanLayer.setAttribute('aria-hidden',String(hidden));
    for(const meta of HUMAN_EMPLOYEES){const el=humanElements.get(meta.id);if(el){el.style.display=hidden?'none':'';el.setAttribute('aria-hidden',String(hidden));el.setAttribute('tabindex',hidden?'-1':'0');}}
    humanApproval.style.display=hidden?'none':'';humanApproval.setAttribute('aria-hidden',String(hidden||!humanApproval.classList.contains('is-requesting')));humanApproval.setAttribute('tabindex',hidden?'-1':'0');
  }
  // A signed-in colleague has one visible body. Hide the placeholder occupant,
  // preserving the workstation and inheriting this state across LOD redraws.
  function syncPresenceWorkplaces(){
    const represented=new Set((presenceState.enabled?presenceState.people:[]).flatMap(person=>[ORGANIZATION_POSITION_META[person.appearanceKey]?.primarySeatId||person.appearanceKey,person.posture==='seated'?person.seatId:null]).filter(Boolean));
    for(const [id,element]of positionElements){
      const hidden=represented.has(ORGANIZATION_POSITION_META[id]?.primarySeatId),value=String(hidden);
      if(element.dataset.presenceRepresented===value)continue;
      element.dataset.presenceRepresented=value;element.style.setProperty('--position-person-display',hidden?'none':'block');
      if(hidden&&element===greetingElement)clearGreeting();
    }
  }
  function setPresence(value={}){if(destroyed)return;lastPresenceValue=value;if(!value.enabled)localPresencePoints.clear();presenceState=presenceMotion.set({...value,people:(value.people||[]).map(person=>{const point=localPresencePoints.get(person.id);return point?{...person,x:point.x,y:point.y,posture:'standing',seatId:''}:person;})});syncPresenceWorkplaces();const present=new Set(presenceMotion.entries.keys());
    for(const [id,el]of presenceElements)if(!present.has(id)){if(el===greetingElement)clearGreeting();el.remove();presenceElements.delete(id);humanElements.delete(id);humanPositions.delete(id);}
    syncLegacyHumanVisibility();
    withPresenceBatch(()=>{for(const [id,entry]of presenceMotion.entries){let el=presenceElements.get(id);if(!el){el=document.createElementNS('http://www.w3.org/2000/svg','g');el.classList.add('cnl-presence');el.dataset.human=id;el.setAttribute('tabindex','0');el.setAttribute('role','button');const select=e=>{e.stopPropagation();if(destroyed||!presenceState.enabled||el.style.display==='none'||performance.now()<suppressClickUntil)return;const person=presenceMotion.entries.get(id)?.person;if(person){setSelectedHuman(id);presenceState.onSelectEmployee({...person});}};el.addEventListener('click',select);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(e);}});presenceLayer.append(el);presenceElements.set(id,el);humanElements.set(id,el);}
      const p=entry.person;el.dataset.current=String(p.current);el.setAttribute('aria-label',`${p.name}${p.title?'，'+p.title:''}，${p.current?'你，':''}在线，查看个人与待办`);el.setAttribute('aria-pressed',String(selectedHuman===id));
      setPresencePoint(entry);
    }});
    ensurePresenceFrame();ambient?.refresh();scheduleViewChange();
  }
  function setLocalPresencePoint(id,point,{heading='down',moving=true}={}){
    const entry=presenceMotion.entries.get(id);if(!entry||!point||![point.x,point.y].every(Number.isFinite))return false;
    const wasSeated=entry.person.posture==='seated';localPresencePoints.set(id,{x:point.x,y:point.y,moving});entry.point={x:point.x,y:point.y};entry.target={...entry.point};entry.motion=null;entry.person={...entry.person,posture:'standing',seatId:''};const wave=moving&&!reducedMotion?Math.sin(performance.now()*.014):0;entry.sample={heading,stride:wave*18,bob:Math.abs(wave)*.7,lean:0,arrived:false};setPresencePoint(entry);if(wasSeated)syncPresenceWorkplaces();if(moving&&entry.person.current)ensurePresenceVisible(id);scheduleViewChange();return true;
  }
  function ensurePresenceVisible(id,{immediate=false,afterFit=false}={}){if(afterFit&&viewTween.active&&cameraOwner==='automatic'){pendingPresenceFocus=id;return true;}const entry=presenceMotion.entries.get(id);if(!entry||!active||!immediate&&(drag||touchGesture||nativeGesture||performance.now()-lastManualCameraAt<600))return false;const rect=svg.getBoundingClientRect(),p=officeDisplayPoint(entry.point,localTeamId),at=projectPoint(p);if(!at)return false;const marginX=Math.min(150,rect.width*.18),top=Math.min(100,rect.height*.16),bottom=Math.max(top,rect.height-Math.min(160,rect.height*.25)),dx=Math.max(marginX,Math.min(rect.width-marginX,at.x))-at.x,dy=Math.max(top,Math.min(bottom,at.y))-at.y;if(Math.hypot(dx,dy)<.5)return false;stopCamera();const factor=immediate?1:.2,from=worldPoint(rect.left,rect.top),to=worldPoint(rect.left+dx*factor,rect.top+dy*factor);panX+=from.x-to.x;panY+=from.y-to.y;applyView();return true;}
  function clearLocalPresencePoint(id){if(!localPresencePoints.delete(id))return;setPresence(lastPresenceValue);}
  function setNavigationTarget(point){navigationTarget=point&&[point.x,point.y].every(Number.isFinite)?{...point}:null;navigationMarker.style.display=navigationTarget?'':'none';if(navigationTarget){const p=officeDisplayPoint(navigationTarget,localTeamId);navigationMarker.setAttribute('transform',`translate(${p.x} ${p.y})`);}return !!navigationTarget;}

  const scheduleViewChange = (duration = 0) => {
    motionUntil = Math.max(motionUntil, performance.now() + duration);
    if (viewFrame || destroyed || !active || document.hidden) return;
    const notify = () => {
      viewFrame = 0;
      if (destroyed || !active || document.hidden) return;
      onViewChange();
      if (performance.now() < motionUntil) viewFrame = requestAnimationFrame(notify);
    };
    viewFrame = requestAnimationFrame(notify);
  };

  function setSelectedNode(id) {
    selected = id;
    if (id) setSelectedHuman(null);
    nodeElements.forEach(el => {
      el.classList.toggle('is-selected', el.dataset.node === id);
      el.setAttribute('aria-pressed', String(el.dataset.node === id));
    });
    if (id) setSelectedAgent(null);
  }

  function setSelectedAgent(id) {
    selectedAgent = id;
    if (id) setSelectedHuman(null);
    agentElements.forEach((el, key) => {
      el.classList.toggle('is-selected', key === id);
      el.setAttribute('aria-pressed', String(key === id));
    });
    if (id && selected) setSelectedNode(null);
  }

  for(const room of OFFICE_ROOMS)for(const team of room.teamZones){const element=teamElements.get(team.id);if(!element)continue;const select=event=>{event.stopPropagation();if(destroyed||localTeamId||performance.now()<suppressClickUntil)return;cancelFloorClick();if(Number.isFinite(event.clientX)&&Number.isFinite(event.clientY))queueFloorMove(event,room.id);else onSelectNode(room.id);};element.addEventListener('click',select);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(event);}});}

  nodeElements.forEach(el => {
    const id=el.dataset.node;if(id==='bulletin')return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (destroyed||localTeamId||performance.now() < suppressClickUntil) return;
      cancelFloorClick();
      if(ROOM_IDS.has(id)&&Number.isFinite(e.clientX)){queueFloorMove(e,id);return;}
      setSelectedNode(id); onSelectNode(id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation();if(destroyed||localTeamId)return;cancelFloorClick();setSelectedNode(id);onSelectNode(id); }
    });
  });

  // Each visible board panel owns its own pointer and keyboard action. The
  // frame remains scenery, so moving through a gap never opens another tab.
  for(const element of svg.querySelectorAll('[data-bulletin-section]')){
    const id=element.dataset.bulletinSection,tile=bulletinTile(OFFICE_BULLETIN_AREA,id);
    if(!tile)continue;
    const enter=()=>{if(destroyed||localTeamId)return;clearGreeting();const at=projectPoint({x:tile.x,y:tile.y-tile.h/2}),rect=container.getBoundingClientRect();if(at)onHoverBulletin(id,{x:at.x+rect.left,y:at.y+rect.top});};
    const leave=()=>{if(document.activeElement!==element)onLeaveBulletin(id);};
    const blur=()=>{if(!element.matches?.(':hover'))onLeaveBulletin(id);};
    const select=event=>{event.stopPropagation();if(destroyed||localTeamId||performance.now()<suppressClickUntil)return;cancelFloorClick();onLeaveBulletin();onSelectBulletin(id);};
    element.addEventListener('pointerenter',enter);element.addEventListener('pointerleave',leave);element.addEventListener('focus',enter);element.addEventListener('blur',blur);element.addEventListener('click',select);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(event);}});
  }

  function statusPhrase(agent) {
    if (agent.selected === false) return '未派遣';
    if (agent.status === 'working') {
      const action = agent.task || agent.currentTask || agent.action || '执行任务';
      return String(action).replace(/[「」“”\s]/g, '').slice(0, 8);
    }
    if (['waiting', 'blocked', 'queued'].includes(agent.status)) return '等待证据交接';
    if (['done', 'completed'].includes(agent.status)) return '任务已交付';
    if (agent.status === 'error') return '任务失败，查看原因';
    return `${String(agent.role || '成员').slice(0, 6)}待命`;
  }

  function setSelectedHuman(id) {
    selectedHuman=id;
    humanElements.forEach((el,key)=>{el.classList.toggle('is-selected',key===id);el.setAttribute('aria-pressed',String(key===id));});
    if(id) { setSelectedNode(null);setSelectedAgent(null); }
  }

  function renderHumans(humans=[]) {
    for(const meta of HUMAN_EMPLOYEES) {
      const human={...meta,...humans.find(h=>h.id===meta.id),color:employeeAppearance(false,employeeAppearanceKey(meta)).uniform};
      let el=humanElements.get(meta.id);
      if(!el) {
        el=document.createElementNS('http://www.w3.org/2000/svg','g');
        el.classList.add('cnl-human');el.dataset.human=meta.id;
        el.setAttribute('tabindex','0');el.setAttribute('role','button');
        const select=e=>{e.stopPropagation();if(presenceState.enabled||localTeamId||performance.now()<suppressClickUntil)return;setSelectedHuman(meta.id);onSelectHuman(meta.id);};
        el.addEventListener('click',select);
        el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(e);}});
        humanLayer.append(el);humanElements.set(meta.id,el);
      }
      el.setAttribute('transform',`translate(${meta.x} ${meta.y})`);
      el.classList.toggle('is-awaiting',human.status==='awaiting_approval');
      el.dataset.status=human.status||'idle';
      const phrase=human.status==='awaiting_approval'?'请你审阅方案':human.status==='waiting'?'已派工 · 等待成果':human.status==='delivery'?'成果待查阅':human.status==='files_available'?'证据已保留 · 可查阅':human.id==='owner'?'暂无待批事项':'待提供资料';
      el.setAttribute('aria-label',`${human.name}，${human.role}，${phrase}`);
      const sitting=meta.seated===true,appearance=employeeAppearance({id:employeeAppearanceKey(human),outfitId:human.outfitId});
      el.classList.toggle('is-seated',sitting);
      const signature=JSON.stringify([human.name,human.role,human.color,human.hair,phrase,sitting]);if(humanSignatures.get(meta.id)===signature)continue;humanSignatures.set(meta.id,signature);
      el.innerHTML=`<title>${esc(human.name)} · ${esc(human.role)}；${esc(phrase)}</title><g class="cnl-human-person">${avatar(human.color,human.hair,{sitting,appearance})}${ambientProps}</g><rect x="-39" y="-38" width="78" height="72" fill="transparent"/><g class="cnl-person-card" transform="translate(0 12)"><text class="cnl-agent-caption" text-anchor="middle">${esc(String(human.name).slice(0,8))}</text></g>`;

    }
  }

  function setAgentPoint(id,point) {
    agentPositions.set(id,{x:point.x,y:point.y});
    const el=agentElements.get(id);if(!el)return;
    el.style.transform=`translate(${point.x}px, ${point.y}px)`;
    el.dataset.x=point.x.toFixed(2);el.dataset.y=point.y.toFixed(2);
    if(point.facing) el.style.setProperty('--facing',String(point.facing));
    if(el===greetingElement)syncGreetingPoint();syncNameLabels();
    const home=AGENT_META[id];el.classList.toggle('is-seated',!!home&&home.seated&&Math.hypot(point.x-home.x,point.y-home.y)<2);
  }

  function motionPhrase(id) {
    const el=agentElements.get(id);if(!el)return;
    const motion=motions.get(id),isLocked=deliveryQueue.locked(id);
    el.classList.toggle('is-walking',!!motion);
    el.classList.toggle('is-carrying',!!motion?.event || el.dataset.motionPhase==='delivering');
    if(motion) el.dataset.motionPhase=motion.kind;
    const phrase=motion?.event?(deliveryParticipants(motion.event)?.collecting?'走去领取资料':'携成果前往交付'):motion?'前往工作位置':isLocked?'当面交接中':null;
    if(phrase) { const text=el.querySelector('.cnl-agent-state');if(text)text.textContent=phrase; }
  }

  function renderAgents(agents,{snap=false}={}) {
    const perNode={};
    Object.entries(AGENT_META).forEach(([id,meta])=>{
      const data=agents.find(agent=>agent.id===id)||{};
      const agent={...meta,...data,id,color:employeeAppearance(true,id).uniform};agentState.set(id,agent);
      const working=agent.selected!==false && !!NODE_META[agent.nodeId] && agent.status==='working';
      let point=[meta.x,meta.y];
      if(working) { if(id==='boss'&&agent.nodeId==='general_office')point=[meta.x,meta.y];else {const offset=perNode[agent.nodeId]||0;perNode[agent.nodeId]=offset+1;const positions=WORK_POSITIONS[agent.nodeId];point=positions[offset%positions.length];} }
      desiredPositions.set(id,{x:point[0],y:point[1]});
      let el=agentElements.get(id);
      if(!el) {
        el=document.createElementNS('http://www.w3.org/2000/svg','g');
        el.classList.add('cnl-agent');el.dataset.agent=id;el.setAttribute('tabindex','0');el.setAttribute('role','button');el.setAttribute('aria-pressed','false');
        el.addEventListener('click',e=>{e.stopPropagation();if(localTeamId||performance.now()<suppressClickUntil)return;setSelectedHuman(null);setSelectedAgent(id);onSelectAgent(id);});
        el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();if(localTeamId)return;setSelectedHuman(null);setSelectedAgent(id);onSelectAgent(id);}});
        agentLayer.append(el);agentElements.set(id,el);
      }
      if(snap||!agentPositions.has(id)) { setAgentPoint(id,desiredPositions.get(id));el.dataset.motionPhase=working?'working':'idle'; }
      el.classList.toggle('is-working',working);el.classList.toggle('is-unassigned',agent.selected===false);el.classList.toggle('is-configured',!!agent.configured);el.classList.toggle('is-selected',id===selectedAgent);
      const phrase=statusPhrase(agent);
      el.setAttribute('aria-label',`${agent.name}，${agent.role}`);
      const signature=JSON.stringify([agent.name,agent.role,agent.color,agent.hair,agent.configured,agent.selected,phrase,working]);
      if(signature!==agentSignatures.get(id)) {
        agentSignatures.set(id,signature);
        el.innerHTML=`<title>${esc(agent.name)} · ${esc(agent.role)}</title><rect class="cnl-agent-hit" x="-40" y="-40" width="80" height="75" rx="8"/><g class="cnl-facing" style="transform:scaleX(var(--facing,1));transform-origin:0 -12px"><g class="cnl-walk-sprite">${avatar(agent.color,meta.hair,{appearance:employeeAppearance({virtual:true,id,outfitId:agent.outfitId})})}${avatar(agent.color,meta.hair,{sitting:true,appearance:employeeAppearance({virtual:true,id,outfitId:agent.outfitId})})}<g class="cnl-carry-document" transform="translate(12 -12)"><rect x="-4" y="-5" width="9" height="11" rx="1"/><path d="M-2-2H3M-2 0H3M-2 2H2" fill="none" stroke="#38a395" stroke-width=".6"/></g></g></g>${ambientProps}<g class="cnl-role-tool" transform="translate(17 -17)"><circle class="cnl-tool-ring" r="7"/><path class="cnl-tool" d="M-3 3L2-2M0-3Q4-4 4-1L2 1L0-1Z"/></g><g class="cnl-person-card" transform="translate(0 12)"><text class="cnl-agent-caption" text-anchor="middle">${esc(String(agent.name).slice(0,8))}</text></g>`;

      }
      motionPhrase(id);
    });
  }

  function clearWalkPose(el) {
    if(!el)return;
    el.style.setProperty('--walk-phase','0');el.style.setProperty('--walk-bob','0px');el.style.setProperty('--walk-lean','0deg');el.style.setProperty('--walk-stride','0deg');el.style.setProperty('--walk-pace','400ms');
    el.classList.remove('is-walking','is-facing-side','is-facing-away');delete el.dataset.heading;
  }

  function stopWalk(id) {
    motions.delete(id);clearWalkPose(agentElements.get(id));
  }

  function ensureMotionFrame() {
    if(motionFrame||destroyed||!active||document.hidden||!motions.size)return;
    motionFrame=requestAnimationFrame(tickMotions);
  }

  function tickMotions(now) {
    motionFrame=0;if(destroyed||!active||document.hidden)return;
    for(const [id,motion] of [...motions]) {
      const sample=walkingSample(motion.route,now-motion.started,motion.duration),el=agentElements.get(id);
      setAgentPoint(id,sample);
      if(el) {
        el.style.setProperty('--walk-phase',String(sample.phase));el.style.setProperty('--walk-bob',`${sample.bob}px`);el.style.setProperty('--walk-lean',`${sample.lean}deg`);el.style.setProperty('--walk-stride',`${sample.stride}deg`);el.style.setProperty('--walk-pace',`${sample.pace||400}ms`);
        el.dataset.heading=sample.heading;el.classList.toggle('is-facing-side',sample.axis==='x');el.classList.toggle('is-facing-away',sample.heading==='up');
      }
      if(sample.arrived) { motions.delete(id);clearWalkPose(el);motion.onArrive?.(); }
    }
    onViewChange();ensureMotionFrame();if(!motions.size)ambient?.refresh();
  }

  function walkTo(id,target,{kind='walking',event,onArrive}={}) {
    const from=agentPositions.get(id);if(!from||!target){onArrive?.();return;}
    stopWalk(id);
    const route=routeBetweenPoints(from,target),length=routeLength(route),el=agentElements.get(id);
    if(event) { el.dataset.deliveryId=deliveryKey(event);el.dataset.deliveryKind=event.deliveryKind||'evidence';el.dataset.targetPerson=deliveryParticipants(event)?.recipient||''; }
    el.dataset.motionPhase=kind;
    const epoch=motionEpoch;
    if(reducedMotion||length<1) { setAgentPoint(id,target);queueMicrotask(()=>{if(!destroyed&&epoch===motionEpoch)onArrive?.();});return; }
    const duration=walkingDuration(route);
    motions.set(id,{route,started:performance.now(),duration,onArrive,kind,event});motionPhrase(id);ensureMotionFrame();ambient?.refresh();
  }

  function resumeWork(id) {
    if(deliveryQueue.locked(id)||motions.get(id)?.event)return;
    const target=desiredPositions.get(id),current=agentPositions.get(id),el=agentElements.get(id);
    if(!target||!current||!el)return;
    const existing=motions.get(id);
    if(existing && Math.hypot(existing.route.at(-1).x-target.x,existing.route.at(-1).y-target.y)<1)return;
    if(Math.hypot(target.x-current.x,target.y-current.y)<1) { el.dataset.motionPhase=agentState.get(id)?.status==='working'?'working':'idle';el.classList.remove('is-delivering','is-carrying');return; }
    walkTo(id,target,{kind:'returning',onArrive:()=>{el.dataset.motionPhase=agentState.get(id)?.status==='working'?'working':'idle';el.classList.remove('is-carrying');renderMotionStatus(id);}});
  }

  function renderMotionStatus(id) {
    const el=agentElements.get(id);if(!el)return;
    const text=el.querySelector('.cnl-agent-state');if(text)text.textContent=statusPhrase(agentState.get(id)||{});motionPhrase(id);
  }

  function deliveryFeedback(event,point) {
    const group=document.createElementNS('http://www.w3.org/2000/svg','g');
    group.classList.add('cnl-delivery-feedback');group.dataset.deliveryId=deliveryKey(event);group.dataset.motionPhase='delivered';
    const x=Math.max(62,Math.min(OFFICE_WORLD.width-150,point.x-100)),y=Math.max(3,point.y-81);
    group.setAttribute('transform',`translate(${x} ${y})`);
    group.innerHTML='<circle cx="100" cy="50" r="7" fill="#f7f7ef"/><path d="M97 50l2 2 4-4" fill="none" stroke="#487568" stroke-width="1.4"/>';
    handoffLayer.append(group);return group;
  }

  function startDeliveries() {
    if(destroyed)return;
    const ready=deliveryQueue.startReady();
    for(const event of ready) {
      const epoch=motionEpoch;
      const pair=deliveryParticipants(event),recipient=pair.recipientHuman?humanPositions.get(pair.recipient):agentPositions.get(pair.recipient);
      const mover=agentPositions.get(pair.mover);
      if(!mover||!recipient) { deliveryQueue.finish(event._deliveryKey);continue; }
      // Lock the actual receiver, including a colleague in transit, until exchange is complete.
      if(!pair.recipientHuman) { stopWalk(pair.recipient);const receiving=agentElements.get(pair.recipient);if(receiving){receiving.dataset.motionPhase='receiving';receiving.classList.add('is-delivering');motionPhrase(pair.recipient);} }
      const receiver=pair.recipientHuman?humanElements.get(pair.recipient):agentElements.get(pair.recipient);
      if(receiver===greetingElement)stopGreetingWave();
      receiver?.classList.add('is-handoff');
      const route=routeBetweenPoints(mover,recipient),length=routeLength(route);
      const near=pointAlongRoute(route,length>25?(length-25)/length:0);
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.classList.add('cnl-delivery-path');path.dataset.deliveryId=event._deliveryKey;path.setAttribute('d',route.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' '));handoffLayer.append(path);
      walkTo(pair.mover,near,{kind:pair.collecting?'collecting':'delivering_walk',event,onArrive:()=>{
        if(destroyed||epoch!==motionEpoch)return;
        const el=agentElements.get(pair.mover);el.dataset.motionPhase='delivering';el.classList.add('is-delivering');motionPhrase(pair.mover);path.remove();
        const timing=handoffTiming(reducedMotion);
        const face=recipient.x>=near.x?1:-1;el.style.setProperty('--facing',String(face));if(!pair.recipientHuman)receiver?.style.setProperty('--facing',String(-face));
        el.classList.add('is-offering');
        let feedback;
        const transfer=setTimeout(()=>{
          handoffTimers.delete(transfer);if(destroyed||epoch!==motionEpoch)return;
          el.classList.remove('is-offering');el.classList.add('is-transferring');receiver?.classList.add('is-acknowledging');
          feedback=deliveryFeedback(event,recipient);
          // This acknowledges a real recorded handoff; it never approves a workflow.
          onDelivery(event);
        },timing.transfer);handoffTimers.add(transfer);
        const timer=setTimeout(()=>{
          handoffTimers.delete(timer);feedback?.remove();receiver?.classList.remove('is-handoff','is-delivering','is-acknowledging');el.classList.remove('is-delivering','is-carrying','is-offering','is-transferring');
          deliveryQueue.finish(event._deliveryKey);startDeliveries();resumeWork(pair.mover);if(!pair.recipientHuman)resumeWork(pair.recipient);syncMotionCounts();
        },timing.total);handoffTimers.add(timer);
      }});
    }
    syncMotionCounts();
  }

  function syncMotionCounts() { svg.dataset.deliveryPending=String(deliveryQueue.pendingCount);svg.dataset.deliveryActive=String(deliveryQueue.activeCount);ambient?.refresh(); }

  function resetMotions() {
    motionEpoch++;
    cancelAnimationFrame(motionFrame);motionFrame=0;motions.clear();deliveryQueue.clear();handoffTimers.forEach(clearTimeout);handoffTimers.clear();handoffLayer.innerHTML='';
    agentElements.forEach(el=>{clearWalkPose(el);el.classList.remove('is-delivering','is-carrying','is-handoff','is-offering','is-transferring','is-acknowledging');el.dataset.motionPhase='idle';delete el.dataset.deliveryId;delete el.dataset.deliveryKind;delete el.dataset.targetPerson;});
    humanElements.forEach(el=>el.classList.remove('is-handoff','is-acknowledging'));syncMotionCounts();
  }

  const onMotionPreferenceChange=event=>{
    reducedMotion=event.matches;ambient?.refresh();if(reducedMotion){stopGreetingWave();cancelPositionTransitions();}presenceMotion.setReducedMotion(reducedMotion);if(!reducedMotion||destroyed)return;
    viewTween.finish();wheelAnchor=null;cancelAnimationFrame(cameraMotionFrame);cameraMotionFrame=0;
    cancelAnimationFrame(motionFrame);motionFrame=0;
    for(const [id,motion] of [...motions]) {motions.delete(id);setAgentPoint(id,motion.route.at(-1));clearWalkPose(agentElements.get(id));motion.onArrive?.();}
    scheduleViewChange();
  };

  function update(state={}) {
    const runId=state.runId??null;runIsActive=!!runId&&['running','working','queued','pending','awaiting_approval','paused'].includes(state.runStatus||state.status);ambient?.refresh();
    const {runChanged,animate,reset,halted}=motionUpdatePolicy({hasUpdated,previousRunId:activeRunId,runId,animateEvents:state.animateEvents,runStatus:state.runStatus||state.status});
    if(reset) resetMotions();
    activeRunId=runId;
    const nodes=state.nodes||{};
    const approvalTarget=HUMAN_EMPLOYEES.find(h=>h.id===state.approvalHumanId)||HUMAN_EMPLOYEES.find(h=>h.id==='owner');approvalHumanId=approvalTarget.id;
    humanApproval.setAttribute('transform',`translate(${approvalTarget.x} ${approvalTarget.y-21})`);humanApproval.setAttribute('aria-label',`${approvalTarget.name}，需要审批`);humanApproval.querySelector('[data-approval-human-name]').textContent=`${approvalTarget.name}`;
    humanApproval.classList.toggle('is-requesting',!!state.humanApproval);humanApproval.setAttribute('aria-hidden',String(!state.humanApproval));
    nodeElements.forEach(el=>{const id=el.dataset.node,status=nodes[id]?.status||(typeof nodes[id]==='string'?nodes[id]:'online');el.dataset.status=status;el.setAttribute('aria-label',id==='bulletin'?NODE_META[id].label:ROOM_IDS.has(id)?`${NODE_META[id].label}，${OFFICE_ROOMS.find(room=>room.id===id).headcount} 人`:`查看${NODE_META[id].label}，${({online:'运行正常',warning:'存在异常',offline:'已离线',recovering:'正在恢复'})[status]||status}`);if(deviceElements.get(id))deviceElements.get(id).dataset.status=status;});
    links.forEach(link=>{const statuses=[nodes[link.dataset.a]?.status||nodes[link.dataset.a],nodes[link.dataset.b]?.status||nodes[link.dataset.b]];['offline','warning','recovering'].forEach(status=>link.classList.toggle(`is-${status}`,statuses.includes(status)));});
    const agents=Array.isArray(state.agents)?state.agents:Object.values(state.agents||{});
    renderHumans(state.humans||[]);syncLegacyHumanVisibility();renderAgents(agents,{snap:!animate&&(runChanged||!hasUpdated)});
    deliveryQueue.ingest(state.logs||[],{animate});startDeliveries();
    if(animate) for(const id of agentElements.keys())resumeWork(id);
    if(halted)agentElements.forEach(el=>{el.dataset.motionPhase=state.runStatus||state.status;});
    if(state.selectedNode!==undefined&&state.selectedNode!==selected)setSelectedNode(state.selectedNode);
    if(state.selectedAgent!==undefined&&state.selectedAgent!==selectedAgent)setSelectedAgent(state.selectedAgent);
    hasUpdated=true;syncNameLabels();ambient?.refresh();scheduleViewChange(700);
  }

  function fitRegionScale(region){return clampOfficeScale(Math.min(OFFICE_WORLD.width/(region.w+90),OFFICE_WORLD.height/(region.h+110)),{automatic:true});}
  function setLocalTeam(id){
    if(localTeamId===id)return;
    clearGreeting();onLeaveBulletin();ambient?.pause();
    for(const [seatId,el]of positionElements){const parent=positionParents.get(seatId);if(parent&&(el.parentNode||el.parent)!==parent)parent.append(el);}
    localTeamId=id;svg.dataset.localTeam=id||'';
    setNavigationTarget(navigationTarget);
    for(const layer of campusLayers){layer.style.display=id?'none':'';layer.setAttribute('aria-hidden',String(!!id));}
    localFloor.style.display=id?'':'none';localFloor.setAttribute('aria-hidden',String(!id));
    const team=officeTeamDetail(id);localFloor.innerHTML=team?renderOfficeTeamFloor(team,{uid,plant}):'';
    if(team)for(const [seatId,el]of positionElements)if(ORGANIZATION_POSITION_META[seatId]?.teamId===id)localSeats.append(el);
    syncLegacyHumanVisibility();withPresenceBatch(()=>{for(const entry of presenceMotion.entries.values())setPresencePoint(entry);});ambient?.resume();
  }
  function focusRegion(region){
    const team=officeTeamDetail(region.id);onNavigationContext(team?.id||region.id);setLocalTeam(team?.id||null);if(team){focusedDepartmentId='ai_data';focusedTeamId=team.id;region=team.detailBounds;}
    const nextScale=fitRegionScale(region);if(team)localFitScale=nextScale;departmentScope=ROOM_IDS.has(region.id)?region.id:null;if(departmentScope)departmentFitScale=nextScale;
    animateView({scale:nextScale,panX:region.x+region.w/2-WORLD_CX,panY:region.y+region.h/2-WORLD_CY+32/nextScale});syncLevelOfDetail();
  }

  const positionKey=seat=>{const occupant=organizationOccupant(seat);return JSON.stringify([seat.x,seat.y,seat.scale,seat.desk,occupant?.name,occupant?.title,occupant?.outfitId]);};
  function cancelPositionTransitions(){for(const animation of positionTransitions.values())animation.cancel();positionTransitions.clear();}
  function warmPositionVariants(){
    if(positionWarmup||positionWarmupIndex>=densePositions.length||destroyed||!active||document.hidden||!globalThis.requestIdleCallback)return;
    positionWarmup=globalThis.requestIdleCallback(deadline=>{
      positionWarmup=0;if(destroyed||!active||document.hidden)return;let count=0;
      while(positionWarmupIndex<densePositions.length&&count<4&&(count===0||deadline.timeRemaining()>3)){
        const seat=densePositions[positionWarmupIndex++],element=positionElements.get(seat.id);count++;
        if(element)positionVariants.prime(element,positionKey(seat),()=>renderOrganizationPositionContents(seat,{use,seated}));
      }
      if(positionWarmupIndex<densePositions.length)warmPositionVariants();
    },{timeout:1500});
  }
  function syncLevelOfDetail(){
    const seats=officeSeatsForView({zoom:1,focusedDepartmentId:departmentScope||focusedDepartmentId,focusedTeamId:localTeamId||null}),visible=new Set(seats.map(seat=>seat.id));let redrawn=false;
    // Hide outgoing footprints first. Keep their parsed SVG detached/cached;
    // never paint both representative and complete geometry at the same time.
    for(const [id,element]of positionElements){const show=visible.has(id);if(element.dataset.visible!==String(show)){element.dataset.visible=String(show);element.style.display=show?'':'none';element.setAttribute('aria-hidden',String(!show));element.setAttribute('tabindex',show?'0':'-1');if(!show){if(element===greetingElement)clearGreeting();positionTransitions.get(element)?.cancel();positionTransitions.delete(element);displayedPositions.delete(id);}}}
    for(const seat of seats){
      const element=positionElements.get(seat.id);if(!element)continue;
      const previous=displayedPositions.get(seat.id),geometryChanged=!previous||previous.x!==seat.x||previous.y!==seat.y||previous.scale!==seat.scale||previous.desk.w!==seat.desk.w||previous.desk.h!==seat.desk.h;
      displayedPositions.set(seat.id,seat);const key=positionKey(seat);
      if(element.dataset.geometry!==key){
        redrawn=true;if(element===greetingElement)clearGreeting();positionTransitions.get(element)?.cancel();positionTransitions.delete(element);
        positionVariants.show(element,key,()=>renderOrganizationPositionContents(seat,{use,seated}));element.dataset.geometry=key;
        const room=OFFICE_ROOMS.find(room=>room.id===seat.departmentId),occupant=organizationOccupant(seat);element.setAttribute('aria-label',`${room.title}，${occupant?.name||seat.label}`);
      }
      if(didSyncPositions&&geometryChanged&&!reducedMotion&&active&&!document.hidden&&element.animate){positionTransitions.get(element)?.cancel();const animation=element.animate([{opacity:0},{opacity:1}],{duration:180,easing:'ease-out'});positionTransitions.set(element,animation);animation.onfinish=()=>{if(positionTransitions.get(element)===animation)positionTransitions.delete(element);};}
    }
    didSyncPositions=true;
    svg.dataset.visiblePosts=String(seats.length);svg.dataset.focusDepartment=departmentScope||focusedDepartmentId||'';svg.dataset.focusTeam=localTeamId||'';withPresenceBatch(()=>{for(const entry of presenceMotion.entries.values())setPresencePoint(entry);});if(redrawn&&ambient?.active){ambient.pause();ambient.resume();}else ambient?.refresh();warmPositionVariants();
  }
  const unsubscribeOccupants=subscribeOrganizationOccupants(()=>{if(!destroyed){positionWarmupIndex=0;syncLevelOfDetail();scheduleViewChange();}});
  function releaseDetailScope(nextScale){if(nextScale<OFFICE_DETAIL_ZOOM){focusedDepartmentId=null;focusedTeamId=null;}}
  function resetOfficeView(){pendingPresenceFocus=null;departmentScope=null;onNavigationContext(null);setLocalTeam(null);focusedDepartmentId=null;focusedTeamId=null;clearGreeting();animateView({scale:1,panX:0,panY:0});syncLevelOfDetail();}

  function applyView() {
    const width = OFFICE_WORLD.width / scale;
    const height = OFFICE_WORLD.height / scale;
    const next=`${WORLD_CX + panX - width / 2} ${WORLD_CY + panY - height / 2} ${width} ${height}`;
    if(next===lastViewBox)return;lastViewBox=next;svg.setAttribute('viewBox',next);syncLevelOfDetail();syncGreetingPoint();
    scheduleViewChange();
  }

  function projectPoint(point, element = svg) {
    const matrix = element.getScreenCTM();
    if (!matrix) return null;
    const projected = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    const rect = container.getBoundingClientRect();
    return { x:projected.x - rect.left, y:projected.y - rect.top };
  }

  function worldPoint(clientX, clientY) {
    const matrix = svg.getScreenCTM();
    return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : new DOMPoint();
  }

  function scaleAt(nextScale,clientX,clientY,before=null) {
    const at=worldPoint(clientX,clientY),next=clampOfficeScale(nextScale);before??=at;releaseDetailScope(next);
    // The viewBox keeps its aspect ratio. Preserve the pointer's world anchor
    // algebraically, avoiding a write -> getScreenCTM layout flush -> write.
    panX=before.x-WORLD_CX-(at.x-WORLD_CX-panX)*scale/next;
    panY=before.y-WORLD_CY-(at.y-WORLD_CY-panY)*scale/next;
    scale=next;applyView();
    return scale;
  }
  function sampleTouches(){const [a,b]=touches.values();return a&&b?{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))}:null;}
  function gesturePoint(event){if(Number.isFinite(event.clientX)&&Number.isFinite(event.clientY))return {x:event.clientX,y:event.clientY};const rect=svg.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};}
  function releasePointer(id){if(svg.hasPointerCapture?.(id))svg.releasePointerCapture(id);}
  function cancelFloorClick(){if(floorClickTimer!==null){clearTimeout(floorClickTimer);floorClickTimer=null;}}
  function isFloorTarget(target){const shared=target?.closest?.('[data-shared-space]');if(shared&&shared.dataset?.sharedSpace!=='data_center')return false;return !target?.closest?.('[data-device], [data-agent], [data-human], [data-position], [data-team], [data-name-for], [data-data-center-rack], [data-data-center-fixture], .cnl-office-fitting, .cnl-landscape, .cnl-department-heading, .cnl-room-glazing, .cnl-human-approval');}
  function queueFloorMove(event,nodeId){
    cancelFloorClick();if(event.detail>1||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return;
    let point=worldPoint(event.clientX,event.clientY);if(localTeamId){const team=officeTeamDetail(localTeamId),b=team.detailBounds;if(point.x<b.x||point.x>b.x+b.w||point.y<b.y||point.y>b.y+b.h)return;point=officeCanonicalPoint(point,localTeamId);point={x:Math.max(team.x+1,Math.min(team.x+team.w-1,point.x)),y:Math.max(team.y+1,Math.min(team.y+team.h-1,point.y))};}const dc=OFFICE_DATA_CENTER,inDataCenter=point.x>=dc.x&&point.x<=dc.x+dc.w&&point.y>=dc.y&&point.y<=dc.y+dc.h;if((point.x<0&&!inDataCenter)||point.y<0||point.x>OFFICE_WORLD.width||point.y>OFFICE_WORLD.height)return;
    const room=OFFICE_ROOMS.find(item=>point.x>item.x&&point.x<item.x+item.w&&point.y>item.y&&point.y<item.y+item.h),target={x:point.x,y:point.y,nodeId:inDataCenter?'data_center':nodeId||room?.id||'shared_lounge',...(localTeamId?{teamId:localTeamId}:{})};
    if(!destroyed&&!document.hidden&&!drag&&!touchGesture&&!nativeGesture)onMovePoint(target);
  }
  function resetInput(){setHoveredDepartment(null);cancelFloorClick();stopCamera();const ids=[...touches.keys()];if(drag)ids.push(drag.id);touches.clear();touchGesture=null;nativeGesture=null;drag=null;svg.classList.remove('is-panning');for(const id of ids)releasePointer(id);}
  function listenInput(target,type,handler,options){target?.addEventListener?.(type,handler,options);inputDisposers.push(()=>target?.removeEventListener?.(type,handler,options));}

  const onPointerDown = e => {
    onLeaveBulletin();
    if(destroyed)return;
    cancelFloorClick();clearGreeting();stopCamera();
    if(e.pointerType==='touch'){
      touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(touches.size>1){e.preventDefault();const next=sampleTouches();setHoveredDepartment(departmentAt(worldPoint(next.x,next.y)));beginManualCamera('touch');nativeGesture=null;touchGesture=next;drag=null;svg.classList.add('is-panning');for(const id of touches.keys())svg.setPointerCapture?.(id);suppressClickUntil=performance.now()+200;return;}
    }
    const object=e.target.closest('[data-node], [data-device], [data-agent], [data-human], [data-position], [data-team], [data-employee], .cnl-human-approval');if(object&&!ROOM_IDS.has(object.dataset.node)&&!object.dataset.position)objectFeedback(object,true);
    if (![0,1].includes(e.button)) return;
    const deferControl=true;
    svg.focus?.({preventScroll:true});
    drag = { id:e.pointerId, x:e.clientX, y:e.clientY, lastX:e.clientX, lastY:e.clientY, moved:false,deferControl };ambient?.refresh();
  };
  const onPointerMove = e => {
    if(destroyed)return;if(!drag&&!touchGesture&&!nativeGesture)setHoveredDepartment(departmentForEvent(e));
    if(touches.has(e.pointerId)){
      touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(touches.size>1){e.preventDefault();const next=sampleTouches();if(touchGesture&&next){const before=worldPoint(touchGesture.x,touchGesture.y),value=officePinchScale(scale,next.distance/touchGesture.distance);if(departmentZoom(value,Math.sign(next.distance-touchGesture.distance))){suppressClickUntil=performance.now()+200;return;}scaleAt(value,next.x,next.y,before);}touchGesture=next;suppressClickUntil=performance.now()+200;return;}
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.moved) { setHoveredDepartment(null);if(drag.deferControl)beginManualCamera('pan');focusedDepartmentId=null;focusedTeamId=null;drag.moved = true; svg.setPointerCapture(e.pointerId); svg.classList.add('is-panning'); }
    const from = worldPoint(drag.lastX, drag.lastY), to = worldPoint(e.clientX, e.clientY);
    panX += from.x - to.x;
    panY += from.y - to.y;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    applyView();
  };
  const onPointerEnd = e => {
    if(destroyed)return;
    const wasPinching=!!touchGesture;
    touches.delete(e.pointerId);if(touches.size<2)touchGesture=null;releasePointer(e.pointerId);
    if(wasPinching){drag=null;svg.classList.remove('is-panning');suppressClickUntil=performance.now()+200;return;}
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) {
      suppressClickUntil = performance.now() + 200;
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    }
    svg.classList.remove('is-panning'); drag = null;setHoveredDepartment(departmentForEvent(e));ambient?.refresh();
  };
  const onBlankClick = e => {
    if (performance.now() < suppressClickUntil) { cancelFloorClick();e.preventDefault(); e.stopPropagation();return; }
    if(isFloorTarget(e.target)&&!e.target?.closest?.('[data-node]'))queueFloorMove(e);
  };
  const onMapDoubleClick=e=>{cancelFloorClick();e.preventDefault();e.stopPropagation();};
  const onMapKey=e=>{if(e.key==='Home'){onCameraIntent('manual');cancelFloorClick();e.preventDefault();resetOfficeView();}};
  const wheelInput=createOfficeWheelInput();
  const onWheel = e => {
    if(destroyed)return;cancelFloorClick();
    e.preventDefault();
    if(nativeGesture||touches.size>1)return;
    const rect=svg.getBoundingClientRect(),input=wheelInput({...e,deltaX:e.deltaX,deltaY:e.deltaY,deltaMode:e.deltaMode,ctrlKey:e.ctrlKey,metaKey:e.metaKey,height:svg.clientHeight||rect.height}),amount=input.dy;
    if(!Number.isFinite(amount)||!amount)return;
    setHoveredDepartment(departmentForEvent(e));beginManualCamera('wheel');if(viewTween.active&&Math.sign(viewTween.target.scale-scale)&&Math.sign(viewTween.target.scale-scale)!==-Math.sign(amount))stopCamera();const next=officeWheelScale(viewTween.target.scale,amount,0,svg.clientHeight||rect.height);if(!officeCameraChanged(viewTween.target,{scale:next}))return;const world=worldPoint(e.clientX,e.clientY);
    if(departmentZoom(next,-Math.sign(amount)))return;releaseDetailScope(next);animateView({scale:next,panX:world.x-WORLD_CX-(world.x-WORLD_CX-panX)*scale/next,panY:world.y-WORLD_CY-(world.y-WORLD_CY-panY)*scale/next},{x:e.clientX,y:e.clientY,world},{manual:true});
  };
  const onGestureStart=e=>{if(destroyed)return;onLeaveBulletin();cancelFloorClick();e.preventDefault();clearGreeting();setHoveredDepartment(departmentForEvent(e));beginManualCamera('pinch');const point=gesturePoint(e);nativeGesture=touches.size>1?null:{lastScale:1,anchor:worldPoint(point.x,point.y)};suppressClickUntil=performance.now()+200;};
  const onGestureChange=e=>{if(destroyed)return;e.preventDefault();if(touches.size>1){nativeGesture=null;return;}if(!nativeGesture||!Number.isFinite(e.scale)||e.scale<=0)return;const point=gesturePoint(e),next=officePinchScale(scale,e.scale/nativeGesture.lastScale);const direction=Math.sign(e.scale-nativeGesture.lastScale);nativeGesture.lastScale=e.scale;if(!departmentZoom(next,direction))scaleAt(next,point.x,point.y,nativeGesture.anchor);suppressClickUntil=performance.now()+200;};
  const onGestureEnd=e=>{if(destroyed)return;e.preventDefault();nativeGesture=null;suppressClickUntil=performance.now()+200;ambient?.refresh();};
  listenInput(svg,'pointerdown',onPointerDown);
  listenInput(svg,'contextmenu',e=>e.preventDefault());
  listenInput(svg,'dblclick',onMapDoubleClick);
  listenInput(svg,'keydown',onMapKey);
  const onObjectHover=e=>{setHoveredDepartment(departmentForEvent(e));const object=e.target.closest?.('[data-node], [data-device], [data-agent], [data-human], [data-position], [data-employee]');if(object!==hoveredObject){hoveredObject=object;if(object&&!ROOM_IDS.has(object.dataset.node)&&!object.dataset.agent&&!object.dataset.human&&!object.dataset.position)objectFeedback(object);}showObjectHint(e);};
  const onObjectOut=e=>{setHoveredDepartment(departmentForEvent({target:e.relatedTarget}));if(departmentHint){if(e.relatedTarget?.closest?.('[data-node]')!==departmentHint.element)clearGreeting();}else if(greetingPerson(e.relatedTarget)!==greetingElement)clearGreeting();};
  const onObjectLeave=()=>{setHoveredDepartment(null);onLeaveBulletin();hoveredObject=null;clearGreeting();};
  const onPersonFocus=e=>{setHoveredDepartment(departmentForEvent(e));showObjectHint(e);};
  const onPersonBlur=onObjectOut;
  svg.addEventListener('pointerover',onObjectHover);
  svg.addEventListener('pointerout',onObjectOut);
  svg.addEventListener('pointerleave',onObjectLeave);
  svg.addEventListener('focusin',onPersonFocus);
  svg.addEventListener('focusout',onPersonBlur);
  listenInput(svg,'pointermove',onPointerMove);
  listenInput(svg,'pointerup',onPointerEnd);
  listenInput(svg,'pointercancel',()=>{resetInput();suppressClickUntil=performance.now()+200;});
  listenInput(svg,'lostpointercapture',onPointerEnd);
  listenInput(svg,'click',onBlankClick,true);
  listenInput(svg,'wheel',onWheel,{passive:false});
  listenInput(svg,'gesturestart',onGestureStart,{passive:false});
  listenInput(svg,'gesturechange',onGestureChange,{passive:false});
  listenInput(svg,'gestureend',onGestureEnd,{passive:false});
  listenInput(globalThis.window,'blur',resetInput);
  const resizeObserver = new ResizeObserver(() => {ambientRect=svg.getBoundingClientRect?.()||ambientRect;syncNameLabels();ambient?.refresh();if(greetingElement||departmentHint){cacheHintScale();syncGreetingPoint();}scheduleViewChange();});
  resizeObserver.observe(container);
  motionPreference?.addEventListener?.('change',onMotionPreferenceChange);
  syncLevelOfDetail();
  renderHumans([]);
  renderAgents([],{snap:true});
  clearGreeting();
  const ambientElement=person=>person.kind==='post'?positionElements.get(person.seatId):person.kind==='virtual'?agentElements.get(person.id):(presenceElements.get(person.id)||humanElements.get(person.id));
  function syncNameLabels(){
    if(destroyed)return;
    const [vx,vy,vw,vh]=lastViewBox.split(' ').map(Number),native=Number(globalThis.visualViewport?.scale)||1,unit=Math.min(ambientRect.width/vw,ambientRect.height/vh),pixelUnit=unit*native;
    if(!(pixelUnit>0))return;
    const width=ambientRect.width*native,height=ambientRect.height*native,offsetX=(ambientRect.width-vw*unit)/2,offsetY=(ambientRect.height-vh*unit)/2,candidates=[];
    const add=(id,name,point,priority,required=false)=>{if(!point||!name)return;const wy=point.y+12/pixelUnit;candidates.push({id,name,priority,required,fontSize:required&&scale<2?7:9,wx:point.x,wy,x:((point.x-vx)*unit+offsetX)*native,y:((wy-vy)*unit+offsetY)*native});};
    for(const [id,seat]of displayedPositions){const element=positionElements.get(id),person=organizationOccupant(id);if(person&&seat.occupantVisible&&element?.dataset.visible!=='false'&&element?.dataset.presenceRepresented!=='true')add('post:'+id,person.name,seat,seat.role==='staff'?3:2,seat.departmentId!=='ai_data');}
    for(const [id,point]of agentPositions){const state=agentState.get(id);if(!localTeamId&&state?.selected!==false)add('virtual:'+id,state?.name||AGENT_META[id]?.name,point,1);}
    for(const [id,entry]of presenceMotion.entries)if(presenceState.enabled&&presenceElements.get(id)?.style.display!=='none')add('human:'+id,entry.person.name,humanPositions.get(id)||entry.point,entry.person.current?0:2);
    const labels=selectOfficeNameLabels(candidates,{width,height,gap:4,fontSize:9}),selected=new Set(labels.map(label=>label.id));
    const nextScale=String(1/pixelUnit);if(nameScale!==nextScale){nameScale=nextScale;nameLayer.style.setProperty('--name-scale',nextScale);}
    for(const [id,element]of nameElements)if(!selected.has(id)){element.remove();nameElements.delete(id);}
    for(const label of labels){let element=nameElements.get(label.id);if(!element){element=document.createElementNS('http://www.w3.org/2000/svg','g');element.classList.add('cnl-permanent-name');element.dataset.nameFor=label.id;element.style.pointerEvents='auto';element.style.cursor='pointer';element.setAttribute('role','button');element.setAttribute('tabindex','0');const select=event=>{event.preventDefault();event.stopPropagation();if(performance.now()<suppressClickUntil)return;const [kind,...keys]=label.id.split(':'),id=keys.join(':');if(kind==='post')onSelectPostEmployee(id);else if(kind==='human'){const person=presenceMotion.entries.get(id)?.person;if(person)presenceState.onSelectEmployee({...person});}else if(kind==='virtual')onSelectAgent(id);};element.addEventListener('click',select);element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){select(event);}});nameLayer.append(element);nameElements.set(label.id,element);}
      const position=`translate(${label.wx} ${label.wy})`;if(element.dataset.position!==position){element.dataset.position=position;element.setAttribute('transform',position);}
      if(element.dataset.name!==label.name||element.dataset.fontSize!==String(label.fontSize)){element.dataset.name=label.name;element.dataset.fontSize=String(label.fontSize);const hitWidth=Math.max(24,label.box.w+8),hitHeight=Math.max(16,label.fontSize+8);element.innerHTML=`<g class="cnl-name-scale"><rect class="cnl-name-hit" x="${-hitWidth/2}" y="${-hitHeight+4}" width="${hitWidth}" height="${hitHeight}" fill="transparent" style="pointer-events:all"/><text class="cnl-name-text" style="font-size:${label.fontSize}px;pointer-events:none" text-anchor="middle">${esc(label.name)}</text></g>`;}
    }
  }
  function ambientPeople(){
    const people=[],rect=ambientRect,[vx,vy,vw,vh]=lastViewBox.split(' ').map(Number),unit=Math.min(rect.width/vw,rect.height/vh);
    const extraX=unit>0?Math.max(0,(rect.width/unit-vw)/2):0,extraY=unit>0?Math.max(0,(rect.height/unit-vh)/2):0;
    const inView=point=>point&&point.x>=vx-extraX&&point.x<=vx+vw+extraX&&point.y>=vy-extraY&&point.y<=vy+vh+extraY;
    for(const [id,el]of agentElements){if(localTeamId)continue;const point=agentPositions.get(id),state=agentState.get(id);if(el!==greetingElement&&inView(point)&&!motions.has(id)&&!deliveryQueue.locked(id)&&!['working','waiting','queued','blocked','error'].includes(state?.status)&&state?.selected!==false)people.push({id,kind:'virtual',...point,seated:el.classList.contains('is-seated'),areaId:NODE_META[state?.nodeId]?.departmentId||AGENT_META[id]?.departmentId});}
    if(presenceState.enabled){for(const [id,entry]of presenceMotion.entries)if(presenceElements.get(id)?.style.display!=='none'&&presenceElements.get(id)!==greetingElement&&inView(humanPositions.get(id)||entry.point)&&!entry.motion&&!deliveryQueue.locked(id))people.push({id,kind:'human',...(humanPositions.get(id)||entry.point),seated:entry.person.posture==='seated',areaId:entry.person.nodeId});}
    else if(!localTeamId)for(const meta of HUMAN_EMPLOYEES){const el=humanElements.get(meta.id),point=humanPositions.get(meta.id);if(el&&el!==greetingElement&&inView(point)&&!['waiting','awaiting_approval'].includes(el.dataset.status)&&!deliveryQueue.locked(meta.id))people.push({id:meta.id,kind:'human',...point,seated:meta.seated===true,areaId:meta.nodeId});}
    for(const [id,seat]of displayedPositions){const element=positionElements.get(id);if(element!==greetingElement&&inView(seat)&&seat.occupantVisible&&element?.dataset.visible!=='false'&&element?.dataset.presenceRepresented!=='true')people.push({id:'post:'+id,kind:'post',seatId:id,x:seat.x,y:seat.y,seated:true,canSip:false,areaId:seat.departmentId});}
    return people;
  }
  const ambientPostRigs=new Map();
  const ambientProperties=['--ambient-head-animation','--ambient-left-animation','--ambient-right-animation','--ambient-body-animation'];
  // Native SVG <use> animation support differs across engines. Promote only
  // active seated people to ordinary SVG groups, keeping every idle seat shared.
  function promoteAmbientPost(element,seatId){
    if(ambientPostRigs.has(seatId))return;
    const person=element.querySelector('.cnl-position-person'),source=person?.querySelector('use.cnl-seated');if(!person||!source)return;
    const rig=document.createElementNS('http://www.w3.org/2000/svg','g');rig.classList.add('cnl-post-live-seated');rig.dataset.ambientSeat=seatId;
    rig.setAttribute('transform',source.getAttribute?.('transform')||'');rig.setAttribute('style',source.getAttribute?.('style')||'');rig.innerHTML=avatarArtwork.seated;
    const display=source.style.display;source.style.display='none';person.append(rig);ambientPostRigs.set(seatId,{source,rig,display});
  }
  function releaseAmbientPost(seatId){const record=ambientPostRigs.get(seatId);if(!record)return;record.rig.remove();record.source.style.display=record.display||'';ambientPostRigs.delete(seatId);}
  function startAmbientPose(el,participant,activity){
    const post=participant.kind==='post',seated=post||el.classList.contains('is-seated'),pose=participant.pose;
    const head=pose==='look'?(post?'cnl-post-look':'cnl-ambient-look'):pose==='nod'?(post?'cnl-post-nod':'cnl-ambient-nod'):pose==='stretch'?'cnl-stretch-head':'none';
    const left=pose==='typing'?(seated?'cnl-post-type-left':'cnl-ambient-type-left'):pose==='stretch'?'cnl-stretch-left':pose==='wave'&&post?'cnl-post-arm-wave':'none';
    const right=pose==='typing'?(seated?'cnl-post-type-right':'cnl-ambient-type-right'):pose==='stretch'?'cnl-stretch-right':pose==='wave'&&!post?'cnl-ambient-wave':pose==='sip'?'cnl-ambient-sip':'none';
    el.dataset.ambient=pose;el.style.setProperty('--ambient-duration',`${Math.max(1,participant.duration||activity.duration)}ms`);el.style.setProperty('--ambient-delay',`${Math.max(0,participant.delay||0)}ms`);
    const partner=activity.participants.find(other=>other.id===participant.partnerId);el.style.setProperty('--ambient-direction',String(partner?partner.x<participant.x?-1:1:participant.direction===-1?-1:1));
    for(const [index,value]of[head,left,right,pose==='settle'?'cnl-settle-body':'none'].entries())el.style.setProperty(ambientProperties[index],value);
    if(post)promoteAmbientPost(el,participant.seatId);
  }
  ambient=mountOfficeAmbient({document,mediaQuery:{get matches(){return reducedMotion;}},
    getPeople:ambientPeople,
    isBlocked:()=>destroyed||!active||document.hidden||!!drag||!!touchGesture||!!nativeGesture,
    onStart:activity=>{for(const participant of activity.participants){const el=ambientElement(participant);if(el)startAmbientPose(el,participant,activity);}},
    onEnd:activity=>{for(const participant of activity.participants){const el=ambientElement(participant);if(el){delete el.dataset.ambient;for(const property of ambientProperties)el.style.setProperty(property,'none');}if(participant.kind==='post')releaseAmbientPost(participant.seatId);}},
  });
  syncNameLabels();

  function prepare(){
    if(destroyed)return;
    ambientRect=svg.getBoundingClientRect?.()||ambientRect;
    syncNameLabels();
  }
  function setActive(value){
    if(destroyed||active===!!value)return;
    active=!!value;
    if(!active){
      inactiveAt=performance.now();cancelAnimationFrame(localTransitionFrame);localTransitionFrame=0;cancelPositionTransitions();if(positionWarmup){globalThis.cancelIdleCallback?.(positionWarmup);positionWarmup=0;}ambient?.pause();clearGreeting();resetInput();stopCamera();
      cancelAnimationFrame(viewFrame);viewFrame=0;cancelAnimationFrame(presenceFrame);presenceFrame=0;
      resetMotions();
    }else{
      if(inactiveAt!==null)presenceMotion.shiftTime(performance.now()-inactiveAt,{since:inactiveAt});
      inactiveAt=null;presenceHiddenAt=null;prepare();warmPositionVariants();ambient?.resume();ensurePresenceFrame();ensureMotionFrame();scheduleViewChange();
    }
  }
  return {
    update,prepare,paintFrame:prepare,setActive,
    setTopology(visible) { svg.classList.toggle('cnl-topology-off', !visible); },
    setSelectedNode,
    setSelectedAgent,
    setSelectedHuman,
    setPresence,getPresenceState:()=>presenceMotion.snapshot(),setLocalPresencePoint,clearLocalPresencePoint,setNavigationTarget,ensurePresenceVisible,screenDirectionToWorld:(dx,dy)=>officeScreenDirection(dx,dy),getLocalTeamId:()=>localTeamId,getDepartmentScope:()=>departmentScope,
    getCameraContext(){const rect=svg.getBoundingClientRect(),unit=Math.min((svg.clientWidth||rect.width)/OFFICE_WORLD.width,(svg.clientHeight||rect.height)/OFFICE_WORLD.height);return {center:officeCanonicalPoint({x:WORLD_CX+panX,y:WORLD_CY+panY},localTeamId),scale,worldPerPixel:1/(Math.max(.0001,unit)*scale),scope:localTeamId||departmentScope||null};},
    restoreCameraContext(context){if(!context?.center||![context.center.x,context.center.y].every(Number.isFinite))return false;stopCamera();const point=officeDisplayPoint(context.center,localTeamId),rect=svg.getBoundingClientRect(),unit=Math.min((svg.clientWidth||rect.width)/OFFICE_WORLD.width,(svg.clientHeight||rect.height)/OFFICE_WORLD.height);scale=clampOfficeScale(context.worldPerPixel>0?1/(context.worldPerPixel*unit):context.scale);panX=point.x-WORLD_CX;panY=point.y-WORLD_CY;cameraOwner='manual';applyView();return true;},
    getHumanAnchor(id='owner') { const el=humanElements.get(id);return el?projectPoint({x:0,y:-15},el):null; },
    focusHuman(id='owner',nextScale) { const point=humanPositions.get(id);if(!point)return false;const value=Number.isFinite(nextScale)?clampOfficeScale(nextScale,{automatic:true}):scale;focusedDepartmentId=null;focusedTeamId=null;animateView({scale:value,panX:point.x-WORLD_CX,panY:point.y-WORLD_CY+52/value});return true; },
    focusPoint(point,nextScale=scale){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return false;cancelFloorClick();focusedDepartmentId=null;focusedTeamId=null;const value=clampOfficeScale(Number.isFinite(nextScale)?nextScale:scale,{automatic:true});animateView({scale:value,panX:point.x-WORLD_CX,panY:point.y-WORLD_CY+32/value});return true;},
    getNodeAnchor(id) { const n = NODE_META[id]; return n ? projectPoint(n) : null; },
    getAgentAnchor(id) { const el = agentElements.get(id); return el ? projectPoint({ x:0, y:-13 }, el) : null; },
    focusAgent(id) {
      const point = agentPositions.get(id);
      if (!point) return false;focusedDepartmentId=null;focusedTeamId=null;
      animateView({panX:point.x-WORLD_CX,panY:point.y-WORLD_CY+52/scale});return true;
    },
    focusArea(id){const area=officeArea(id);if(!area)return false;focusedDepartmentId=area.nodeId||OFFICE_ROOMS.find(room=>room.id===area.id)?.id||null;focusedTeamId=area.nodeId?area.id:null;focusRegion(area);return true;},
    focusNode(id) {
      const point=NODE_META[id];if(!point)return false;
      const room=OFFICE_ROOMS.find(room=>room.id===id);
      if(room){focusedDepartmentId=room.id;focusedTeamId=null;focusRegion(room);}
      else {focusedDepartmentId=null;focusedTeamId=null;animateView({panX:point.x-WORLD_CX,panY:point.y-WORLD_CY+52/scale});}return true;
    },
    zoom(delta = .15) {if(!Number.isFinite(delta)||!delta)return scale;beginManualCamera('zoom');if(viewTween.active&&Math.sign(viewTween.target.scale-scale)&&Math.sign(viewTween.target.scale-scale)!==Math.sign(delta))stopCamera();const next=clampOfficeScale(viewTween.target.scale+delta);if(localTeamId&&next<localFitScale*.65){resetOfficeView();return 1;}if(departmentZoom(next,Math.sign(delta)))return viewTween.target.scale;releaseDetailScope(next);return animateView({scale:next},null,{manual:true}).scale;},
    resetView:resetOfficeView,
    destroy() {
      destroyed = true;cancelAnimationFrame(localTransitionFrame);localTransitionFrame=0;cancelPositionTransitions();if(positionWarmup){globalThis.cancelIdleCallback?.(positionWarmup);positionWarmup=0;}positionVariants.clear();unsubscribeOccupants();ambient?.destroy();ambient=null;
      resetInput();for(const dispose of inputDisposers)dispose();inputDisposers.length=0;
      stopCamera();clearGreeting();svg.removeEventListener('pointerover',onObjectHover);svg.removeEventListener('pointerout',onObjectOut);svg.removeEventListener('pointerleave',onObjectLeave);svg.removeEventListener('focusin',onPersonFocus);svg.removeEventListener('focusout',onPersonBlur);
      resizeObserver.disconnect();
      motionPreference?.removeEventListener?.('change',onMotionPreferenceChange);
      document.removeEventListener?.('visibilitychange',presenceVisibility);cancelAnimationFrame(presenceFrame);presenceFrame=0;presenceMotion.destroy();presenceElements.clear();
      cancelAnimationFrame(viewFrame);
      resetMotions();
      container.innerHTML = '';
    },
  };
}

export { NODE_META };
