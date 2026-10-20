import {cp,mkdir,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),src=join(root,'src'),output=join(root,'dist');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await cp(src,output,{recursive:true,filter:path=>!path.endsWith('.DS_Store')});
const files={};
async function visit(dir,prefix=''){for(const item of await readdir(dir,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())await visit(join(dir,item.name),name+'/');else files[name]=createHash('sha256').update(await readFile(join(dir,item.name))).digest('hex');}}
await visit(output);await writeFile(join(output,'asset-manifest.json'),JSON.stringify({version:'4.1.0',files},null,2)+'\n');
console.log(`Client built: ${Object.keys(files).length} assets. Existing office assets preserved byte-for-byte.`);
