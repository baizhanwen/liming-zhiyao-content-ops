import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';
const load=t=>runtimeFixture(t).load('lib/json-byte-budget.ts');
const exact=value=>new TextEncoder().encode(JSON.stringify(value)).length;

for(const [name,value] of [
  ['empty object',{}],['empty array',[]],['scalars',[null,true,false,0,-0,1e-7,1e21,Number.NaN,Number.POSITIVE_INFINITY]],
  ['ascii and punctuation',{a:'"/\\',b:'plain'}],['control characters',Array.from({length:32},(_,i)=>String.fromCharCode(i))],
  ['unicode and separators',{中文:'😀é汉\u2028\u2029',surrogates:['\ud800','\udc00','\ud800\ud800','\udc00\udc00','\ud800\udc00']}],
  ['undefined object fields and array holes',{omit:undefined,keep:null,list:Object.assign(new Array(3),{0:undefined,2:3})}],
  ['null prototype record',Object.assign(Object.create(null),{x:'汉'})],
  ['shared references',{a:{x:1},b:null}],
]) test(`exact JSON UTF-8 budget matches native serialization: ${name}`,t=>{
  const {assertJsonByteBudget,JsonByteBudgetExceededError}=load(t),bytes=exact(value);assert.equal(assertJsonByteBudget(value,bytes),bytes);assert.throws(()=>assertJsonByteBudget(value,bytes-1),JsonByteBudgetExceededError);
});
test('repeated references count each occurrence without being mistaken for cycles',t=>{
  const {assertJsonByteBudget}=load(t),shared={x:'😀'},value=[shared,shared];assert.equal(assertJsonByteBudget(value,exact(value)),exact(value));
});
test('deterministic mixed Unicode data matches native JSON at 500 boundaries',t=>{
  const {assertJsonByteBudget,JsonByteBudgetExceededError}=load(t);let state=12345;
  const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  for(let i=0;i<500;i++){
    const text=String.fromCharCode(...Array.from({length:next()%100},()=>next()%65536)),value={['key'+text]:[text,next()/1000,null,{text}]},bytes=exact(value);
    assert.equal(assertJsonByteBudget(value,bytes),bytes);assert.throws(()=>assertJsonByteBudget(value,bytes-1),JsonByteBudgetExceededError);
  }
});
test('oversize control text is refused without serializing or UTF-8 encoding it',t=>{
  const {assertJsonByteBudget,JsonByteBudgetExceededError}=load(t),value={text:'\0'.repeat(2000000)},native=JSON.stringify,encoder=TextEncoder.prototype.encode;
  try {JSON.stringify=()=>{throw Error('serialization forbidden');};TextEncoder.prototype.encode=()=>{throw Error('encoding forbidden');};assert.throws(()=>assertJsonByteBudget(value,100),JsonByteBudgetExceededError);}finally{JSON.stringify=native;TextEncoder.prototype.encode=encoder;}
});
test('cycles, hooks, getters and unsupported records fail explicitly',t=>{
  const {assertJsonByteBudget}=load(t),cycle={};cycle.self=cycle;
  const getter=Object.defineProperty({},'value',{enumerable:true,get(){throw Error('getter must not execute');}});
  for(const value of [cycle,{toJSON(){return 'changed';}},getter,new Date(),1n,undefined])assert.throws(()=>assertJsonByteBudget(value,1000),TypeError);
});
test('zero and invalid limits are handled explicitly',t=>{
  const {assertJsonByteBudget,JsonByteBudgetExceededError}=load(t);assert.throws(()=>assertJsonByteBudget(null,0),JsonByteBudgetExceededError);for(const limit of [-1,NaN,Infinity,0.5])assert.throws(()=>assertJsonByteBudget({},limit),TypeError);
});
