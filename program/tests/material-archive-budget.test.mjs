import assert from 'node:assert/strict';
import test from 'node:test';
import * as fflate from 'fflate';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

function helper(t){const f=runtimeFixture(t);f.mockModule('fflate',fflate);return {...f,...f.load('lib/material-archive.ts'),limits:f.load('lib/material-transfer-limits.ts')};}
const manifest=(names=[])=>({format:'liming-video-library-package',version:1,entries:[{assets:names.map(blobName=>({blobName}))}]});
const pack=(names=[],files={},level=6,value=manifest(names))=>fflate.zipSync({'manifest.json':fflate.strToU8(JSON.stringify(value)),...files},{level});
function resize(bytes,name,size,{central=true,local=true}={}){
  const copy=bytes.slice(),view=new DataView(copy.buffer);for(let i=0;i<copy.length-46;i++){
    const signature=view.getUint32(i,true);let length,offset;
    if(signature===0x02014b50&&central){length=view.getUint16(i+28,true);offset=46;}
    else if(signature===0x04034b50&&local){length=view.getUint16(i+26,true);offset=30;}else continue;
    if(fflate.strFromU8(copy.subarray(i+offset,i+offset+length))===name)view.setUint32(i+(signature===0x02014b50?24:22),size,true);
  }return copy;
}

for(const level of [0,6]) test(`stored/deflated level ${level} archive preserves binary and Unicode manifest`,async t=>{
  const h=helper(t),data=Uint8Array.from([0,255,128,42]),value=manifest(['asset-测试']);value.entries[0].notes='原始正文\n';
  const result=await h.readMaterialArchive(new Blob([pack(['asset-测试'],{'media/asset-测试':data},level,value)]));
  assert.deepEqual(new Uint8Array(await result.files.get('media/asset-测试').arrayBuffer()),data);assert.deepEqual(result.manifest,value);
});
test('archive file-size cap refuses before reading bytes',async t=>{
  const h=helper(t);let read=false;await assert.rejects(h.readMaterialArchive({size:h.limits.MATERIAL_MAX_ARCHIVE_BYTES+1,arrayBuffer(){read=true;throw Error('must not read');}}),/ZIP 过大/);assert.equal(read,false);
});
test('declared compressed bomb is refused before output allocation',async t=>{
  const h=helper(t),bytes=resize(pack(['a'],{'media/a':new Uint8Array(16)}),'media/a',h.limits.MATERIAL_MAX_MEDIA_BYTES+1);
  await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/媒体超过 750 MiB/);
});
test('aggregate declared media cap is checked across all files',async t=>{
  const h=helper(t);let bytes=pack(['a','b'],{'media/a':new Uint8Array(1),'media/b':new Uint8Array(1)});bytes=resize(resize(bytes,'media/a',400*1024*1024),'media/b',400*1024*1024);
  await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/媒体超过 750 MiB/);
});
test('declared oversized manifest is refused before expansion',async t=>{
  const h=helper(t),bytes=resize(pack(),'manifest.json',h.limits.MATERIAL_MAX_MANIFEST_BYTES+1);await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/清单超过/);
});
for(const level of [0,6]) test(`forged small size at level ${level} cannot truncate and import oversized output`,async t=>{
  const h=helper(t),bytes=resize(pack(['a'],{'media/a':new Uint8Array(2*1024*1024)},level),'media/a',1);await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/实际展开量超过声明大小/);
});
test('directory and local size disagreement is refused',async t=>{
  const h=helper(t),bytes=resize(pack(['a'],{'media/a':new Uint8Array(10)}),'media/a',1,{local:false});await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/目录与实际文件不一致/);
});
test('short expansion cannot masquerade as a complete large attachment',async t=>{
  const h=helper(t),bytes=resize(pack(['a'],{'media/a':new Uint8Array(1)}),'media/a',h.limits.MATERIAL_MAX_MEDIA_BYTES);await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/文件不完整/);
});
test('duplicate central names refuse the whole archive',async t=>{
  const h=helper(t),bytes=pack(['aaa','bbb'],{'media/aaa':new Uint8Array(1),'media/bbb':new Uint8Array(1)},0);
  for(let i=0;i<bytes.length-9;i++) if(fflate.strFromU8(bytes.subarray(i,i+9))==='media/bbb')bytes.set(fflate.strToU8('media/aaa'),i);
  await assert.rejects(h.readMaterialArchive(new Blob([bytes])),/文件名无效或重复/);
});
for(const name of ['../outside','media/../outside','media/..','media/a/b','media/\\a']) test(`unsafe/unexpected path ${name} is refused`,async t=>{
  const h=helper(t);await assert.rejects(h.readMaterialArchive(new Blob([pack([],{[name]:new Uint8Array(1)})])),/文件名无效/);
});
test('unlisted media and missing listed media each refuse before submission',async t=>{
  const h=helper(t);await assert.rejects(h.readMaterialArchive(new Blob([pack([] ,{'media/a':new Uint8Array(1)})])),/清单以外/);await assert.rejects(h.readMaterialArchive(new Blob([pack(['a'])])),/缺少媒体文件/);
});
test('empty directory entries remain compatible with conventional ZIP producers',async t=>{
  const h=helper(t),result=await h.readMaterialArchive(new Blob([pack([] ,{'media/':new Uint8Array()})]));assert.equal(result.files.size,2);
});
test('streaming ZIP with data descriptors remains compatible',async t=>{
  const h=helper(t),chunks=[],zip=new fflate.Zip((error,data)=>{assert.equal(error,null);chunks.push(data);});
  const file=new fflate.ZipDeflate('manifest.json');zip.add(file);file.push(fflate.strToU8(JSON.stringify(manifest())),true);zip.end();
  const result=await h.readMaterialArchive(new Blob(chunks));assert.deepEqual(result.manifest,manifest());
});
for(const value of [{entries:[]},{format:'liming-video-library-package',version:1,entries:[]},{format:'liming-video-library-package',version:1,entries:Array.from({length:101},()=>({assets:[]}))},manifest(['a','a'])]) test('invalid format/count/duplicate attachment is rejected locally',async t=>{
  const h=helper(t);await assert.rejects(h.readMaterialArchive(new Blob([pack([],{},6,value)])),/迁移包|每包|附件名称/);
});
test('shared media references across entries use one archive file',async t=>{
  const h=helper(t),value=manifest(['a']);value.entries.push({assets:[{blobName:'a'}]});const result=await h.readMaterialArchive(new Blob([pack(['a'],{'media/a':new Uint8Array(1)},6,value)]));assert.equal(result.files.size,2);assert.equal(result.manifest.entries.length,2);
});
test('bounded response refuses declared oversize before reading and cancels',async t=>{
  const h=helper(t);let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'100'}});await assert.rejects(h.readMaterialResponse(response,10,'synthetic export cap'),/synthetic export cap/);assert.equal(cancelled,true);
});
test('bounded response checks actual bytes and cancels with a forged header',async t=>{
  const h=helper(t);let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(11));},cancel(){cancelled=true;}}),{headers:{'content-length':'1'}});await assert.rejects(h.readMaterialResponse(response,10,'synthetic export cap'),/synthetic export cap/);assert.equal(cancelled,true);
});
test('bounded response accepts exact boundary and preserves bytes',async t=>{
  const h=helper(t),bytes=Uint8Array.from([0,255,42]);assert.deepEqual(await h.readMaterialResponse(new Response(bytes),3,'synthetic cap'),bytes);
});

test('archive metadata file count is capped before expansion',async t=>{
  const h=helper(t),files={'manifest.json':fflate.strToU8(JSON.stringify(manifest()))};for(let i=0;i<h.limits.MATERIAL_MAX_ARCHIVE_FILES;i++)files[`media/a${i}`]=new Uint8Array();await assert.rejects(h.readMaterialArchive(new Blob([fflate.zipSync(files,{level:0})])),/文件数量超限/);
});
test('truncated archive and missing manifest are rejected',async t=>{
  const h=helper(t),bytes=pack();await assert.rejects(h.readMaterialArchive(new Blob([bytes.subarray(0,bytes.length-10)])),/ZIP 损坏/);await assert.rejects(h.readMaterialArchive(new Blob([fflate.zipSync({'media/a':new Uint8Array(1)})])),/缺少 manifest/);
});
test('actual parser constants preserve supported server media and record limits',t=>{
  const h=helper(t);assert.equal(h.limits.MATERIAL_MAX_MEDIA_BYTES,750*1024*1024);assert.equal(h.limits.MATERIAL_MAX_MANIFEST_BYTES,20000000);assert.equal(h.limits.MATERIAL_MAX_ENTRIES,100);assert.equal(h.limits.MATERIAL_MAX_ASSETS_PER_ENTRY,120);
});
