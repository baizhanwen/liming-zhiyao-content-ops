import assert from 'node:assert/strict';
import test from 'node:test';
import * as fflate from 'fflate';
import {runtimeFixture} from './helpers/runtime-fixture.mjs';
const options={maximumBytes:20*1024*1024,maximumFiles:4096,label:'Excel'};
const load=t=>{const f=runtimeFixture(t);f.mockModule('fflate',fflate);return f.load('lib/bounded-zip.ts');};
function resize(bytes,name,size){const copy=bytes.slice(),view=new DataView(copy.buffer);for(let i=0;i<copy.length-46;i++){const sig=view.getUint32(i,true);if(![0x02014b50,0x04034b50].includes(sig))continue;const n=view.getUint16(i+(sig===0x02014b50?28:26),true),p=sig===0x02014b50?46:30;if(fflate.strFromU8(copy.subarray(i+p,i+p+n))===name)view.setUint32(i+(sig===0x02014b50?24:22),size,true);}return copy;}
for(const level of [0,6])test(`bounded selected ZIP preserves bytes at compression level ${level}`,async t=>{
 const {openBoundedZip}=load(t),bytes=Uint8Array.from([0,255,42]),archive=await openBoundedZip(new Blob([fflate.zipSync({a:bytes},{level})]),options),files=await archive.read(new Map([['a',3]]),3);assert.deepEqual(new Uint8Array(await files.get('a').arrayBuffer()),bytes);
});
test('size cap refuses before file read',async t=>{const {openBoundedZip}=load(t);let read=false;await assert.rejects(openBoundedZip({size:options.maximumBytes+1,arrayBuffer(){read=true;throw Error('must not read');}},options),/大小超限/);assert.equal(read,false);});
test('declared selected size and combined size refuse before decompression',async t=>{
 const {openBoundedZip}=load(t),archive=await openBoundedZip(new Blob([fflate.zipSync({a:new Uint8Array(6),b:new Uint8Array(6)})]),options);await assert.rejects(archive.read(new Map([['a',5]]),20),/展开大小超限/);await assert.rejects(archive.read(new Map([['a',6],['b',6]]),11),/展开总量超限/);
});
test('forged selected output size cannot silently truncate',async t=>{
 const {openBoundedZip}=load(t),bytes=resize(fflate.zipSync({a:new Uint8Array(2*1024*1024)}),'a',1),archive=await openBoundedZip(new Blob([bytes]),options);await assert.rejects(archive.read(new Map([['a',10]]),10),/实际展开量超过/);
});
test('unselected compressed content is never inflated',async t=>{
 const f=runtimeFixture(t);class ForbiddenInflate{static compression=8;constructor(){throw Error('unused content inflated');}}
 f.mockModule('fflate',{...fflate,UnzipInflate:ForbiddenInflate});const {openBoundedZip}=f.load('lib/bounded-zip.ts');
 const bytes=resize(fflate.zipSync({a:[new Uint8Array([42]),{level:0}],unused:new Uint8Array(1000000)}),'unused',2147483647),archive=await openBoundedZip(new Blob([bytes]),options),files=await archive.read(new Map([['a',1]]),1);assert.deepEqual(new Uint8Array(await files.get('a').arrayBuffer()),new Uint8Array([42]));
});
test('metadata file count refuses before expanded allocation',async t=>{
 const {openBoundedZip}=load(t),bytes=fflate.zipSync({a:new Uint8Array(),b:new Uint8Array()});await assert.rejects(openBoundedZip(new Blob([bytes]),{...options,maximumFiles:1}),/文件数量超限/);
});
for(const name of ['../outside','/absolute','a\\b','a/../b'])test(`invalid ZIP path ${name} is refused`,async t=>{const {openBoundedZip}=load(t);await assert.rejects(openBoundedZip(new Blob([fflate.zipSync({[name]:new Uint8Array()})]),options),/异常文件名/);});
test('missing selected content and truncated archive fail clearly',async t=>{
 const {openBoundedZip}=load(t),bytes=fflate.zipSync({a:new Uint8Array(1)}),archive=await openBoundedZip(new Blob([bytes]),options);await assert.rejects(archive.read(new Map([['b',1]]),1),/缺少必要/);await assert.rejects(openBoundedZip(new Blob([bytes.subarray(0,bytes.length-10)]),options),/损坏/);
});
test('ordinary streaming ZIP data descriptors remain readable',async t=>{
 const {openBoundedZip}=load(t),parts=[],zip=new fflate.Zip((error,data)=>{assert.equal(error,null);parts.push(data);}),file=new fflate.ZipDeflate('a');zip.add(file);file.push(new Uint8Array([42]),true);zip.end();const archive=await openBoundedZip(new Blob(parts),options),result=await archive.read(new Map([['a',1]]),1);assert.deepEqual(new Uint8Array(await result.get('a').arrayBuffer()),new Uint8Array([42]));
});

test('aborted ZIP open refuses before reading',async t=>{const {openBoundedZip}=load(t),controller=new AbortController();controller.abort();let read=false;await assert.rejects(openBoundedZip({size:1,arrayBuffer(){read=true;return new ArrayBuffer(1);}},{...options,signal:controller.signal}),error=>error.name==='AbortError');assert.equal(read,false);});
test('superseded file bytes are discarded before inspection or inflation',async t=>{const {openBoundedZip}=load(t),controller=new AbortController();let release;const pending=openBoundedZip({size:1,arrayBuffer(){return new Promise(resolve=>{release=resolve;});}},{...options,signal:controller.signal});controller.abort();release(new ArrayBuffer(1));await assert.rejects(pending,error=>error.name==='AbortError');});
test('aborted selected read refuses before expansion',async t=>{const {openBoundedZip}=load(t),controller=new AbortController(),archive=await openBoundedZip(new Blob([fflate.zipSync({a:new Uint8Array(1)})]),{...options,signal:controller.signal});controller.abort();await assert.rejects(archive.read(new Map([['a',1]]),1),error=>error.name==='AbortError');});
