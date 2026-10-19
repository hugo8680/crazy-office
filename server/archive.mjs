import {createHash} from 'node:crypto';
import {buildRunOutcome} from './outcomes.mjs';

export const MAX_ARCHIVE_FILES = 1000;
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MANIFEST_NAME = '交付清单.json';
const MAX_NAME_BYTES = 240;
const UTF8_FLAG = 0x0800;
const DOS_DATE = 0x0021; // 1980-01-01; no user/local timezone in a stable archive.
const crcTable = Uint32Array.from({length:256},(_,index)=>{
  let crc=index;
  for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;
  return crc>>>0;
});

function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function text(value,max=500) { return typeof value==='string'?value.slice(0,max):''; }
function clipped(value,budget) {
  let result='',used=0;
  for(const character of value) {
    const size=Buffer.byteLength(character);
    if(used+size>budget)break;
    result+=character;used+=size;
  }
  return result;
}
function parts(name) {
  const dot=name.lastIndexOf('.');
  return dot>0&&Buffer.byteLength(name.slice(dot))<=32
    ? [name.slice(0,dot),name.slice(dot)] : [name,''];
}
function fitName(stem,extension,suffix='') {
  return clipped(stem,MAX_NAME_BYTES-Buffer.byteLength(extension+suffix))+suffix+extension;
}
function safeBaseName(value,index) {
  let name=typeof value==='string'?value.slice(-4096).replace(/\\/g,'/').split('/').at(-1):'';
  // Round-trip malformed surrogates before JSON and ZIP encode the same name.
  name=Buffer.from(name||'','utf8').toString('utf8').normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/[<>:"|?*]/g,'_').trim()
    .replace(/^\.+/,'').replace(/[.\s]+$/u,'');
  if(!name)name='文件-'+(index+1);
  if(/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))name='_'+name;
  const [stem,extension]=parts(name);
  return fitName(stem,extension);
}
function distinctName(name,used) {
  let candidate=name,number=2;
  const [stem,extension]=parts(name);
  while(used.has(candidate.toLowerCase()))candidate=fitName(stem,extension,' ('+(number++)+')');
  used.add(candidate.toLowerCase());
  return candidate;
}
function manifestFor(run,files) {
  const outcome=buildRunOutcome(run);
  return {
    runId:text(run?.id,120),taskName:text(run?.title,300)||'未命名任务',
    executionStatus:text(run?.status,80)||'unknown',
    outcome:{status:outcome.status,label:outcome.label,summary:outcome.summary,
      findings:outcome.findings.map(finding=>{
        const item={label:text(finding.label,160),status:text(finding.status,80)};
        if(typeof finding.value==='string')item.value=text(finding.value,500);
        if(typeof finding.detail==='string')item.detail=text(finding.detail,1000);
        return item;
      }),nextActions:outcome.nextActions.map(action=>text(action,1000))},
    files:files.map(file=>({name:file.name,bytes:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')})),
  };
}
function entry(name,bytes,offset) {
  const filename=Buffer.from(name,'utf8'),checksum=crc32(bytes);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(UTF8_FLAG,6);
  local.writeUInt16LE(0,8);local.writeUInt16LE(0,10);local.writeUInt16LE(DOS_DATE,12);
  local.writeUInt32LE(checksum,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);
  local.writeUInt16LE(filename.length,26);local.writeUInt16LE(0,28);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);
  central.writeUInt16LE(UTF8_FLAG,8);central.writeUInt16LE(0,10);central.writeUInt16LE(0,12);central.writeUInt16LE(DOS_DATE,14);
  central.writeUInt32LE(checksum,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);
  central.writeUInt16LE(filename.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);
  central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE((0o100644*65536)>>>0,38);
  central.writeUInt32LE(offset,42);
  return {local:[local,filename,bytes],central:[central,filename],length:local.length+filename.length+bytes.length};
}

/**
 * Build a ZIP from already-authorized, already-read registered artifacts.
 * Stored entries need no compression dependency and preserve arbitrary bytes.
 * No filesystem, network or model operations occur here. The 100 MiB limit
 * covers business file contents; ZIP headers and the generated manifest are
 * additional bounded metadata (at most 1001 root-directory entries).
 */
export function buildArtifactArchive({run={},files}={}) {
  if(!Array.isArray(files))throw new TypeError('打包文件列表必须是数组。');
  if(files.length>MAX_ARCHIVE_FILES)throw new RangeError('单次最多打包1000个文件。');
  let total=0;
  // Validate the complete request before computing hashes or allocating output.
  for(const file of files) {
    if(!file||typeof file!=='object'||!Buffer.isBuffer(file.bytes))throw new TypeError('每个打包文件必须提供实际读取的Buffer内容。');
    total+=file.bytes.length;
    if(total>MAX_ARCHIVE_BYTES)throw new RangeError('打包文件内容合计不能超过100 MiB。');
  }
  const used=new Set([MANIFEST_NAME.toLowerCase()]);
  const entries=files.map((file,index)=>({name:distinctName(safeBaseName(file.name,index),used),bytes:file.bytes}));
  const manifest=Buffer.from(JSON.stringify(manifestFor(run,entries),null,2)+'\n','utf8');
  entries.push({name:MANIFEST_NAME,bytes:manifest});
  const local=[],central=[];let offset=0;
  for(const file of entries) {
    const encoded=entry(file.name,file.bytes,offset);
    local.push(...encoded.local);central.push(...encoded.central);offset+=encoded.length;
  }
  const centralSize=central.reduce((size,buffer)=>size+buffer.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);
  end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  return Buffer.concat([...local,...central,end],offset+centralSize+end.length);
}
