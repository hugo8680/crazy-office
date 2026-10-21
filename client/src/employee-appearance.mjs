/* A small reusable wardrobe, independent of authority or employment type.
 * The same identity keeps its outfit across the SVG and WebGL renderers. */
const freeze=value=>Object.freeze(value);
export const EMPLOYEE_WARDROBE=freeze([
  freeze({id:'atelier',label:'工装外套',garment:'overshirt',shirt:'#ede5d4',jacket:'#597963',trousers:'#374c49',shoes:'#303d38',trim:'#a5b5a0'}),
  freeze({id:'linen',label:'亚麻衬衫',garment:'shirt',shirt:'#d5b382',jacket:'#d5b382',trousers:'#5c6258',shoes:'#51483e',trim:'#f2e6cd'}),
  freeze({id:'marine',label:'海军针织',garment:'knit',shirt:'#506a88',jacket:'#506a88',trousers:'#3d4854',shoes:'#303e47',trim:'#a8bdce'}),
  freeze({id:'terracotta',label:'休闲夹克',garment:'jacket',shirt:'#f2e7cf',jacket:'#b46f58',trousers:'#535851',shoes:'#473e39',trim:'#e6bd9d'}),
  freeze({id:'plum',label:'细纹开衫',garment:'cardigan',shirt:'#efdfd7',jacket:'#856e8f',trousers:'#4e4658',shoes:'#3c3644',trim:'#c2afc6'}),
  freeze({id:'cloud',label:'城市轻装',garment:'hoodie',shirt:'#b7c9ca',jacket:'#b7c9ca',trousers:'#536268',shoes:'#e1ddcf',trim:'#eef0e1'}),
]);
const byId=new Map(EMPLOYEE_WARDROBE.map(style=>[style.id,style]));
const hairs=freeze(['#423b36','#6d5142','#343d3a','#57443e','#776251','#454451']);
const skins=freeze(['#efc7a8','#e7b994','#d8aa83','#f1d0b0']);
export function appearanceHash(value='') {let hash=2166136261;for(const char of String(value).trim().toLowerCase()){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619)>>>0;}return hash;}
export function employeeAppearance(value=false,personId='',outfitId=''){
  const options=value&&typeof value==='object'?value:{virtual:value===true,id:personId,outfitId};
  const virtual=options.virtual===true||options.kind==='virtual';
  const key=String(options.appearanceKey||options.username||options.email||options.id||'colleague').trim().toLowerCase(),hash=appearanceHash(key);
  const style=byId.get(options.outfitId)||EMPLOYEE_WARDROBE[hash%EMPLOYEE_WARDROBE.length];
  const skin=skins[(hash>>>6)%skins.length],accent='#419c9e';
  return freeze({...style,outfitId:style.id,uniform:style.jacket,badge:virtual?'#b6ddd7':'#f4ead6',skin,hair:hairs[(hash>>>12)%hairs.length],synthetic:virtual,face:virtual?'#e4eddf':skin,earcap:virtual?'#537b7a':skin,accent,eye:virtual?'#397879':'#3e4544'});
}
// Compatibility for older consumers; this no longer prescribes an identity uniform.
export const EMPLOYEE_APPEARANCE=freeze({virtual:employeeAppearance(true),human:employeeAppearance(false)});
export function employeeAppearanceKey(person={}) {return String(person.appearanceKey||person.organizationSeatIds?.[0]||person.username||person.email||person.employeeUsername||person.personId||person.id||'colleague');}
export function employeeAppearanceStyle(appearance) {
 const a=appearance||employeeAppearance();
 return `--shirt:${a.uniform};--hair:${a.hair};--skin:${a.face};--skin-warm:${a.skin};--trousers:${a.trousers};--shoes:${a.shoes};--inner-shirt:${a.shirt};--cloth-trim:${a.trim};--eye:${a.eye};--earcap:${a.earcap};--synthetic:${a.synthetic?'block':'none'};--natural:${a.synthetic?'none':'block'};--garment-open:${['overshirt','jacket','cardigan'].includes(a.garment)?'block':'none'};--garment-knit:${a.garment==='knit'?'block':'none'};--garment-hood:${a.garment==='hoodie'?'block':'none'};--garment-pocket:${['overshirt','shirt'].includes(a.garment)?'block':'none'}`;
}
