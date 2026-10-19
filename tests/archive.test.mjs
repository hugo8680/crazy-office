import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildArtifactArchive,MAX_ARCHIVE_BYTES,MAX_ARCHIVE_FILES} from '../server/archive.mjs';

const python=process.env.OFFICE_PYTHON||'/usr/bin/python3';
const unpackScript=`
import base64,binascii,io,json,sys,zipfile
data=sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data),'r') as archive:
    broken=archive.testzip()
    if broken is not None:
        raise ValueError('CRC check failed: '+broken)
    result=[]
    for info in archive.infolist():
        body=archive.read(info)
        result.append({'name':info.filename,'size':info.file_size,'compressedSize':info.compress_size,'method':info.compress_type,'flags':info.flag_bits,'crc':info.CRC,'actualCrc':binascii.crc32(body)&0xffffffff,'date':list(info.date_time),'mode':info.external_attr>>16,'base64':base64.b64encode(body).decode('ascii')})
    manifest=json.loads(archive.read('交付清单.json').decode('utf-8'))
print(json.dumps({'entries':result,'manifest':manifest},ensure_ascii=False))
`;
function unpack(bytes) {
  const child=spawnSync(python,['-c',unpackScript],{input:bytes,encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
const run=(status='completed')=>({id:'run-test',title:'服务器采购比价',status,scenarioId:'procurement',tasks:[],artifacts:[]});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('stored UTF-8 ZIP independently unpacks Chinese names, binary bytes and CRC in Python',()=>{
  const files=[{id:'f1',name:'年度报表.xlsx',bytes:Buffer.from([0,1,255,128,13,10,0])},{id:'f2',name:'说明.txt',bytes:Buffer.from('中文与 emoji 🧭，内容原样保留。','utf8')}];
  const bytes=buildArtifactArchive({run:run(),files});assert(Buffer.isBuffer(bytes));
  const result=unpack(bytes);assert.equal(result.entries.length,3);
  for(const file of files) {
    const entry=result.entries.find(item=>item.name===file.name);assert(entry);
    assert.equal(entry.base64,file.bytes.toString('base64'));assert.equal(entry.size,file.bytes.length);
    assert.equal(entry.compressedSize,file.bytes.length);assert.equal(entry.method,0);assert(entry.flags&0x0800);
    assert.equal(entry.crc,entry.actualCrc);assert.deepEqual(entry.date,[1980,1,1,0,0,0]);
    assert.equal(entry.mode&0o170000,0o100000);
    assert.deepEqual(result.manifest.files.find(item=>item.name===file.name),{name:file.name,bytes:file.bytes.length,sha256:sha(file.bytes)});
  }
  assert.deepEqual(Object.keys(result.manifest),['runId','taskName','executionStatus','outcome','files']);
});

test('empty file payloads and a manifest-only archive are valid ZIPs',()=>{
  const result=unpack(buildArtifactArchive({run:run('cancelled'),files:[{name:'空文件.txt',bytes:Buffer.alloc(0)}]}));
  assert.equal(result.entries[0].size,0);assert.equal(result.entries[0].crc,0);
  assert.equal(result.manifest.files[0].sha256,sha(Buffer.alloc(0)));
  const empty=unpack(buildArtifactArchive({files:[]}));assert.deepEqual(empty.entries.map(item=>item.name),['交付清单.json']);assert.deepEqual(empty.manifest.files,[]);
});

test('duplicate basenames, case-insensitive names and manifest collisions are numbered without overwrite',()=>{
  const names=['folder/报价.csv','other/报价.csv','报价 (2).csv','REPORT.TXT','report.txt','交付清单.json','交付清单.JSON','é.txt','e\u0301.txt'];
  const files=names.map((name,index)=>({name,bytes:Buffer.from(String(index))}));
  const result=unpack(buildArtifactArchive({run:run(),files})),actual=result.entries.map(item=>item.name);
  assert.equal(new Set(actual.map(name=>name.toLowerCase())).size,actual.length);
  assert.deepEqual(actual.slice(0,3),['报价.csv','报价 (2).csv','报价 (2) (2).csv']);
  assert(actual.includes('report (2).txt'));assert.equal(actual.filter(name=>name==='交付清单.json').length,1);
  assert(actual.includes('交付清单 (2).json'));assert(actual.includes('交付清单 (3).JSON'));
  assert(actual.includes('é (2).txt'));assert.equal(result.manifest.files.length,files.length);
  for(const [index,item] of result.manifest.files.entries())assert.equal(item.sha256,sha(files[index].bytes));
});

test('unsafe names become safe root-relative portable names without path traversal or controls',()=>{
  const names=['../../report.txt','C:\\Users\\someone\\data.csv','/absolute/结果.json','..','.','...','folder/','\u0000\u0007\u001fhidden\u007f.txt','\u202e伪装\u2066.txt','C:drive.txt','CON.txt','file?.txt','\ud800.txt'];
  const result=unpack(buildArtifactArchive({run:run(),files:names.map((name,index)=>({name,bytes:Buffer.from([index])}))}));
  for(const entry of result.entries) {
    assert(!/[\\/\p{Cc}\p{Cf}]/u.test(entry.name));assert(!entry.name.startsWith('.'));assert(!entry.name.includes(':'));
    assert(!['.','..'].includes(entry.name));assert.equal(entry.name,pathRoot(entry.name));
  }
  assert(result.entries.some(item=>item.name==='_CON.txt'));
  assert(result.entries.some(item=>item.name==='�.txt'));
  assert.deepEqual(result.entries.slice(0,3).map(item=>item.name),['report.txt','data.csv','结果.json']);
  assert(result.manifest.files.every((file,index)=>file.name===result.entries[index].name));
});
function pathRoot(name) { return name.split('/').at(-1).split('\\').at(-1); }

test('long Unicode names stay valid UTF-8 and bounded even after duplicate numbering',()=>{
  const long='精细交付'.repeat(150)+'.xlsx';
  const result=unpack(buildArtifactArchive({run:run(),files:[{name:long,bytes:Buffer.alloc(0)},{name:long,bytes:Buffer.alloc(0)}]}));
  const names=result.manifest.files.map(item=>item.name);
  for(const name of names){assert(Buffer.byteLength(name)<=240);assert(name.endsWith('.xlsx'));assert(!name.includes('�'));}
  assert.notEqual(names[0],names[1]);assert(names[1].endsWith(' (2).xlsx'));
});

test('manifest faithfully records partial failed or cancelled execution without copying private input or paths',()=>{
  for(const status of ['failed','cancelled','awaiting_approval']) {
    const current={...run(status),input:{password:'input-private-secret'},configs:{key:'config-private-secret'},runDir:'/Users/private/local-secret',outcome:{summary:'UNTRUSTED_MODEL_SUMMARY',artifacts:[{path:'/etc/private'}]},approval:status==='awaiting_approval'?{title:'请真实负责人审批'}:null};
    const bytes=buildArtifactArchive({run:current,files:[{id:'actual-file',name:'部分结果.json',bytes:Buffer.from('{}'),path:'/Users/private/not-exported'}]});
    const result=unpack(bytes),serialized=JSON.stringify(result.manifest);
    assert.equal(result.manifest.executionStatus,status);assert.equal(result.manifest.outcome.status,status);
    for(const forbidden of ['input-private-secret','config-private-secret','local-secret','/etc/private','UNTRUSTED_MODEL_SUMMARY','not-exported'])assert(!serialized.includes(forbidden),forbidden);
    assert.equal(result.manifest.files[0].name,'部分结果.json');assert(!Object.hasOwn(result.manifest.files[0],'id'));
    assert(!Object.hasOwn(result.manifest.outcome,'artifactGroups'));
  }
});

test('archive content is stable and does not mutate input buffers or run data',()=>{
  const current=run(),file={name:'原始.bin',bytes:Buffer.from([1,2,3,4])};
  const before=JSON.stringify(current),bufferBefore=Buffer.from(file.bytes);
  const a=buildArtifactArchive({run:current,files:[file]}),b=buildArtifactArchive({run:current,files:[file]});
  assert(a.equals(b));assert.equal(JSON.stringify(current),before);assert(file.bytes.equals(bufferBefore));
  file.bytes[0]=99;assert.equal(unpack(a).entries[0].base64,bufferBefore.toString('base64'));
});

test('file count limit includes all business files and allows exactly 1000 plus the generated manifest',()=>{
  assert.equal(MAX_ARCHIVE_FILES,1000);
  const files=Array.from({length:MAX_ARCHIVE_FILES},(_,index)=>({name:'文件-'+index+'.txt',bytes:Buffer.alloc(0)}));
  const result=unpack(buildArtifactArchive({run:run(),files}));assert.equal(result.entries.length,1001);assert.equal(result.manifest.files.length,1000);
  assert.throws(()=>buildArtifactArchive({run:run(),files:[...files,files[0]]}),/1000/);
});

test('aggregate byte quota is enforced before output; exact 100 MiB is supported',()=>{
  assert.equal(MAX_ARCHIVE_BYTES,100*1024*1024);
  const oneMiB=Buffer.alloc(1024*1024);
  const files=Array.from({length:100},(_,index)=>({name:index+'.bin',bytes:oneMiB}));
  assert.throws(()=>buildArtifactArchive({run:run(),files:[...files,{name:'one-more-byte',bytes:Buffer.from([0])}]}),/100 MiB/);
  const bytes=buildArtifactArchive({run:run(),files});assert(bytes.length>MAX_ARCHIVE_BYTES);
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),101);
});

test('malicious and malformed file content types are rejected rather than coerced or stringified',()=>{
  for(const files of [undefined,null,{},'files'])assert.throws(()=>buildArtifactArchive({run:run(),files}),/数组/);
  for(const item of [null,{},'data',{name:'x',bytes:'secret'},{name:'x',bytes:new Uint8Array([1])},{name:'x',bytes:{length:100,toString(){throw new Error('must not stringify');}}}])assert.throws(()=>buildArtifactArchive({run:run(),files:[item]}),/Buffer/);
  assert.doesNotThrow(()=>buildArtifactArchive({run:null,files:[{name:{toString(){throw new Error('must not stringify');}},bytes:Buffer.alloc(0)}]}));
});

test('independent ZIP reader detects payload corruption by CRC',()=>{
  const original=buildArtifactArchive({run:run(),files:[{name:'checksum.txt',bytes:Buffer.from('123456789')}]});
  assert.equal(original.readUInt32LE(14),0xcbf43926);
  const corrupted=Buffer.from(original),start=30+corrupted.readUInt16LE(26)+corrupted.readUInt16LE(28);corrupted[start]^=1;
  const child=spawnSync(python,['-c',unpackScript],{input:corrupted,encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,/CRC|BadZipFile/);
});
