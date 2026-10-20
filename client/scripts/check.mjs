import {readdir} from 'node:fs/promises';import {resolve,join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
async function visit(dir){for(const item of await readdir(dir,{withFileTypes:true})){const p=join(dir,item.name);if(item.isDirectory()){if(item.name!=='vendor')await visit(p);}else if(/\.(m?js)$/.test(item.name)){const r=spawnSync(process.execPath,['--check',p],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}}}
await visit(join(root,'src'));await visit(join(root,'scripts'));console.log('Client JavaScript syntax: passed');
