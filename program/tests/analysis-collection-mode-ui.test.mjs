import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';

function handler(file,name,bindings){
 const source=ts.createSourceFile(file,readFileSync(new URL('../'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit)};visit(source);assert.ok(found,name);
 const compiled=ts.transpileModule(found.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return new Function(...Object.keys(bindings),compiled+'\nreturn '+name)(...Object.values(bindings));
}
for(const collectionMode of ['anonymous','cookie'])test('URL submission explicitly selects '+collectionMode,async()=>{
 const requests=[];const scope={reader:{invalidate(){}}};
 const submit=handler('components/AnalysisWorkspace.tsx','submitUrl',{
  organizationId:'org',projectId:'project',analysisProfile:'max',transcriptReviewEnabled:false,visualAnalysisMode:'vision_only',visualSamplingLevel:'quick',executionMode:'controlled_parallel',collectionMode,
  setSubmitting(){},setError(){},setSubmitMessage(){},setTranscriptReviewEnabled(){},taskReader:{current:scope},appendCreated(){},loadVideos:async()=>{},
  FormData:class{get(name){return name==='url'?'https://v.douyin.com/synthetic/':''}},readError:async()=>'',
  scopedFetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return Response.json({video:{id:'v'},job:{id:'j'}})}
 });await submit({preventDefault(){},currentTarget:{reset(){}}});assert.equal(requests[0].body.collectionMode,collectionMode);
});
for(const mode of [undefined,'anonymous','cookie'])test('retry preserves continuation contract with mode '+mode,async()=>{
 const requests=[];const pendingJobActions={current:new Set()};
 const retry=handler('components/AnalysisWorkspace.tsx','retry',{
  pendingJobActions,setError(){},setJobActionId(){},taskReader:{current:{reader:{invalidate(){}}}},setJobFeedback(){},setJobs(){},setTaskSnapshotTimes(){},organizationId:'org',projectId:'project',
  scopedFetch:async(url,init)=>{requests.push({url,body:init.body?JSON.parse(init.body):null});return Response.json({job:{id:'job'}})},readError:async()=>'',loadVideos:async()=>{}
 });await retry('job',undefined,mode);assert.deepEqual(requests[0].body,mode?{collectionMode:mode}:null);assert.equal(pendingJobActions.current.size,0);
});
for(const sourceType of ['url','upload'])test('reanalysis '+sourceType+' only submits a collection selection for URL sources',async()=>{
 const requests=[];const reanalyze=handler('components/AnalysisDetail.tsx','reanalyze',{
  videoId:'video',organizationId:'org',projectId:'project',profile:'max',visualAnalysisMode:'vision_only',visualSamplingLevel:'quick',executionMode:'controlled_parallel',collectionMode:'cookie',
  detail:{video:{source_type:sourceType,source_url:'https://www.douyin.com/video/synthetic'}},setSelectedId(){},setNotice(){},runAction:async(_name,work)=>work(),readApiError:async()=>'',
  scopedFetch:async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({})}
 });await reanalyze();assert.equal(requests[0].collectionMode,sourceType==='url'?'cookie':undefined);
});
for(const switchScope of [false,true])test('Cookie upload updates the actual snapshot flag and guards a scope switch: '+switchScope,async()=>{
 const original={reader:{}},taskReader={current:original},updates=[],messages=[];let respond;
 const response=new Promise(resolve=>{respond=resolve});
 const update=handler('components/AnalysisWorkspace.tsx','updateDouyinCookies',{
  taskReader,organizationId:'org',projectId:'project',setCookieUpdating(){},setCookieMessage:value=>messages.push(value),setError(){},
  FormData,setService:change=>updates.push(change({publicLinkCookieConfigured:true,publicLinkAuthenticationMode:'anonymous',uploadedCookieConfigured:false})),readError:async()=>'',scopedFetch:async()=>response
 });const input={files:[new File(['synthetic'],'cookies.txt')],value:'synthetic'};const pending=update({currentTarget:input});
 if(switchScope)taskReader.current={reader:{}};respond(Response.json({configured:true,updatedAt:'2026-11-16T00:00:00Z',cookieCount:1}));await pending;
 assert.equal(updates.length,switchScope?0:1);if(!switchScope){assert.equal(updates[0].uploadedCookieConfigured,true);assert.equal(updates[0].publicLinkAuthenticationMode,'anonymous');assert.equal(updates[0].publicLinkCookieConfigured,true)}
 assert.equal(input.value,'');assert.equal(messages.some(message=>message.includes('已更新')), !switchScope);
});
test('collection selector describes explicit Cookie use and keeps compact help accessible',()=>{
 const source=ts.transpileModule(readFileSync(new URL('../components/AnalysisCollectionModeSelect.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const loaded={exports:{}};new Function('require','module','exports',source)(name=>{
  if(name==='react')return React;if(name==='react/jsx-runtime')return jsx;
  if(name.includes('analysis-collection-mode'))return{ANALYSIS_COLLECTION_MODE_LABELS:{anonymous:'匿名采集',cookie:'Cookie 采集'}};
  throw new Error('Unexpected dependency '+name)
 },loaded,loaded.exports);
 const html=renderToStaticMarkup(React.createElement(loaded.exports.AnalysisCollectionModeSelect,{value:'cookie',compact:true,disabled:true,onChange(){}}));
 assert.match(html,/value="cookie" selected=""/);assert.match(html,/disabled=""/);assert.match(html,/aria-describedby=/);assert.match(html,/class="sr-only"/);assert.match(html,/当前公司上传的抖音 Cookie/);
});
