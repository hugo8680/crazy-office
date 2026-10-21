import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';

const indexURL=new URL('../src/index.html',import.meta.url);
async function activeStyles(){
  const html=await readFile(indexURL,'utf8'),files=new Map();
  async function visit(url){
    assert.equal(url.protocol,'file:','Office UI styles are reviewed local sources.');
    if(files.has(url.href))return;
    const source=await readFile(url,'utf8'),tree=postcss.parse(source,{from:url.pathname});files.set(url.href,{name:url.pathname.split('/').at(-1),source,tree});
    const imports=[];tree.walkAtRules('import',rule=>{const href=rule.params.match(/^(?:url\(\s*)?["']([^"']+)["']/)?.[1];assert.ok(href,'Use a local quoted stylesheet import.');imports.push(new URL(href,url));});
    for(const imported of imports)await visit(imported);
  }
  const links=[...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match=>match[1]);
  for(const href of links)await visit(new URL(href,indexURL));
  return {html,links,files:[...files.values()]};
}
function customProperties(files){const values=new Map();for(const file of files)file.tree.walkDecls(/^--/,decl=>values.set(decl.prop,decl.value));return values;}
function resolveValue(value,properties){return value.replace(/var\((--[\w-]+)\)/g,(_,name)=>{assert.ok(properties.has(name),`Undefined design token: ${name}`);return resolveValue(properties.get(name),properties);});}

test('the active office loads the foundation before shared and component styles and excludes the legacy UI',async()=>{
  const {links,files}=await activeStyles();
  assert.equal(links[0],'./ui-foundation.css');
  assert.ok(links.indexOf('./dialog-system.css')>links.indexOf('./ui-foundation.css'));
  assert.ok(links.indexOf('./erp.css')>links.indexOf('./dialog-system.css'));
  assert.ok(links.indexOf('./session-ui.css')>links.indexOf('./dialog-system.css'));
  for(const legacy of ['styles.css','office.css','view-controls.css','login.css','join.css'])assert.equal(files.some(file=>file.name===legacy),false,`${legacy} must not style the active office.`);
});

test('theme tokens have one owner and a changed theme propagates through dialog and ERP aliases',async()=>{
  const {files}=await activeStyles(),foundation=files.find(file=>file.name==='ui-foundation.css');assert.ok(foundation);
  const owned=new Map();foundation.tree.walkDecls(/^--office-ui-/,decl=>owned.set(decl.prop,decl.value));
  for(const file of files){
    if(file!==foundation)file.tree.walkDecls(/^--office-ui-/,decl=>assert.fail(`${file.name} redefines ${decl.prop}; edit the foundation instead.`));
    file.tree.walkDecls(decl=>{for(const reference of decl.value.matchAll(/var\((--office-ui-[\w-]+)/g))assert.ok(owned.has(reference[1]),`${file.name} references missing ${reference[1]}`);});
  }
  const properties=customProperties(files);properties.set('--office-ui-accent','#123456');properties.set('--office-ui-paper','#faf9f1');
  assert.equal(resolveValue(properties.get('--dialog-accent'),properties),'#123456');assert.equal(resolveValue(properties.get('--erp-sage'),properties),'#123456');
  assert.equal(resolveValue(properties.get('--dialog-paper'),properties),'#faf9f1');assert.equal(resolveValue(properties.get('--erp-paper'),properties),'#faf9f1');
  const erp=files.find(file=>file.name==='erp.css');let rootFont='';erp.tree.walkRules('.erp-layer',rule=>{if(rule.parent.type==='root')rule.walkDecls('font',decl=>rootFont=decl.value);});
  properties.set('--office-ui-text-body','17px');properties.set('--office-ui-font-sans','FoundationTest, sans-serif');const resolved=resolveValue(rootFont,properties);
  assert.match(resolved,/17px/);assert.match(resolved,/FoundationTest/);
});

test('feature styles cannot replace global type/theme or take over business viewport geometry',async()=>{
  const {files}=await activeStyles();
  const globalSelector=/(?:^|[,\s])(?:html|body|:root|\*)(?=$|[,\s.#:[>])/;
  for(const file of files){
    if(file.name==='ui-foundation.css')continue;
    file.tree.walkRules(rule=>{
      if(rule.selector.includes(':root'))rule.walkDecls(decl=>assert.ok(file.name==='dialog-system.css'&&decl.prop.startsWith('--dialog-'),`${file.name}: root theme declarations belong to ui-foundation.css.`));
      if(globalSelector.test(rule.selector))rule.walkDecls(decl=>assert.equal(/^(?:font(?:-.*)?|color|background(?:-.*)?)$/.test(decl.prop),false,`${file.name}: global ${decl.prop} override in ${rule.selector}`));
      if(file.name!=='workspace.css'&&rule.selector==='.erp-layer')rule.walkDecls(decl=>assert.equal(/^(?:position|inset|top|right|bottom|left|width|height|max-width|max-height)$/.test(decl.prop),false,`${file.name}: workspace.css owns ERP viewport geometry.`));
      if(file.name==='erp.css')rule.walkDecls(decl=>assert.doesNotMatch(decl.value,/--workspace-(?:visible|logical|inverse)/,'Business content must not duplicate viewport compensation.'));
    });
    file.tree.walkAtRules('font-face',()=>assert.fail(`${file.name}: shared font registration belongs to ui-foundation.css.`));
  }
});

test('scene, business pages and office controls have separate sibling frames',async()=>{
  const {html}=await activeStyles(),main=html.match(/<main\b[^>]*id="lab"[^>]*>([\s\S]*?)<\/main>/)?.[0];assert.ok(main);
  const stack=[],parents=new Map();
  for(const token of main.matchAll(/<\/?(main|div|nav)\b([^>]*)>/g)){
    if(token[0].startsWith('</')){assert.equal(stack.pop()?.tag,token[1]);continue;}
    const id=token[2].match(/\bid="([^"]+)"/)?.[1];if(id)parents.set(id,stack.at(-1)?.id);stack.push({tag:token[1],id});
  }
  for(const id of ['workspace-stage','workspace-business','workspace-chrome'])assert.equal(parents.get(id),'lab',`${id} must be a sibling display frame.`);
  assert.equal(parents.get('office-scene'),'workspace-stage');assert.equal(parents.get('action-dock'),'workspace-chrome');
  const office=await readFile(new URL('../src/office.js',import.meta.url),'utf8');
  const call=office.match(/mountErp\(\{([\s\S]*?)\}\)/)?.[1];assert.ok(call);
  const container=call.match(/\bcontainer\s*:\s*([\w$]+)/)?.[1];assert.ok(container,'The shell must pass an explicit business container.');
  assert.match(office,new RegExp(`\\b${container}\\s*=\\s*document\\.querySelector\\(['\"]#workspace-business['\"]\\)`),'ERP must be mounted in the shared business frame, not body or the scene.');
});


test('shared business text and primary controls preserve readable contrast when the theme changes',async()=>{
  const {files}=await activeStyles(),properties=customProperties(files),token=name=>resolveValue(properties.get('--office-ui-'+name),properties);
  const luminance=hex=>{assert.match(hex,/^#[0-9a-f]{6}$/i);const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb.reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);};
  for(const [foreground,background] of [['ink','paper'],['muted','paper'],['muted','soft'],['on-accent','accent'],['on-accent','accent-hover'],['warning','warning-soft']]){
    const light=[luminance(token(foreground)),luminance(token(background))].sort((a,b)=>b-a),ratio=(light[0]+.05)/(light[1]+.05);
    assert.ok(ratio>=4.5,`${foreground} on ${background} needs at least 4.5:1 contrast; received ${ratio.toFixed(2)}.`);
  }
});
