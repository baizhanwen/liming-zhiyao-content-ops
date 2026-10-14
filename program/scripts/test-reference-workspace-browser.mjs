import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root=fileURLToPath(new URL('..',import.meta.url)),fixture=path.join(root,'.local/reference-workspace-browser',Date.now().toString());
await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixture,'entry.tsx'),'import React from "react";import {createRoot} from "react-dom/client";import {KnowledgeWorkspace} from "../../../components/KnowledgeWorkspace";import "../../../app/globals.css";createRoot(document.getElementById("root")!).render(<KnowledgeWorkspace initialOrganizationId="org" initialProjectId="project"/>);');
const {chromium}=await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE||path.join(root,'.local/ecommerce-browser/node_modules/playwright/index.mjs')).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});
const initial={id:'knowledge',title:'Synthetic knowledge',category:'brand_story',body:'Synthetic knowledge body for isolated tests.',source_type:'manual',source_ref:null,status:'draft',current_version:1,confirmed_at:null,updated_at:'2026-10-14T00:00:00.000Z'};
const initialStrategy={id:'strategy',name:'Synthetic strategy',version:2,status:'draft',positioning:'Synthetic position',target_audience:'Synthetic audience',pain_points:['Question'],pillars:['Education'],objectives:['Education'],updated_at:initial.updated_at};
let browser,page,mode='normal',item={...initial},strategy={...initialStrategy},posts=[],errors=[],releaseWrite,refreshFailed=false;
const checks=[];
const check=async(name,fn)=>{await fn();assert.deepEqual(errors,[]);checks.push({name,passed:true});console.log('PASS '+name);};
const createForm=()=>page.locator('.knowledge-create form');
const editForm=()=>page.locator('.knowledge-edit-form');
async function fresh(){mode='normal';item={...initial};strategy={...initialStrategy};posts=[];errors=[];refreshFailed=false;await page.goto(server.resolvedUrls.local[0]);await createForm().waitFor();}
async function fillCreate(){await createForm().locator('[name=title]').fill('Keep synthetic title');await createForm().locator('[name=body]').fill('Keep synthetic body and source before acknowledgement.');}
async function openEditor(){await page.locator('.knowledge-edit-menu summary').click();await editForm().locator('[name=body]').fill('Keep modified synthetic body before acknowledgement.');}
async function strategyTab(){await page.getByRole('button',{name:'内容策略',exact:true}).click();await page.locator('.strategy-create form').waitFor();}
try {
  await server.listen();browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();let body,status=200;
    if(url.pathname==='/api/organizations')body={organizations:[{id:'org',name:'Synthetic company'},{id:'other',name:'Other company'}]};
    else if(url.pathname==='/api/projects')body={projects:[{id:'project',name:'Synthetic space'},{id:'second',name:'Second space'}],organizationRole:'member'};
    else if(method==='GET'&&url.pathname==='/api/knowledge'){if(refreshFailed){await route.abort('internetdisconnected');return;}body={items:[item],canWrite:true,canManage:true};}
    else if(method==='GET'&&url.pathname==='/api/strategies')body={strategies:[strategy],canWrite:true,canManage:true};
    else if(method==='GET'&&url.pathname==='/api/knowledge/knowledge')body={history:[]};
    else if(method!=='GET'){
      const input=route.request().postDataJSON();posts.push({path:url.pathname,method,input});
      if(mode==='offline'){await route.abort('internetdisconnected');return;}
      if(mode==='hold')await new Promise(resolve=>{releaseWrite=resolve;});
      if(mode==='invalidAck')body={};
      else if(mode==='conflict'||(method==='PATCH'&&input.expectedUpdatedAt!==item.updated_at)){status=409;body={error:{code:'KNOWLEDGE_STATE_CHANGED',message:'资料版本已改变，本次未保存。请复制修改，再刷新核对。'}};}
      else if(url.pathname==='/api/knowledge'&&method==='POST'){status=201;body={item:{...initial,id:'created',title:input.title,body:input.body}};}
      else if(method==='PATCH'){status=201;item={...item,title:input.title,body:input.body,current_version:2,updated_at:'2026-10-14T00:00:00.002Z'};body={item};if(mode==='refreshFailure')refreshFailed=true;}
      else if(url.pathname.endsWith('/confirm')){item={...item,status:'confirmed',updated_at:'2026-10-14T00:00:00.001Z'};body={item};}
      else if(method==='DELETE'){item={...item,status:'archived'};body={id:item.id,status:'archived'};}
      else if(url.pathname.endsWith('/activate')){strategy={...strategy,status:'active',updated_at:'2026-10-14T00:00:00.003Z'};body={strategy};}
      else if(url.pathname==='/api/strategies'){status=201;body={strategy:{...strategy,id:'created-strategy',version:3}};}
      else throw Error('Unexpected write '+url.pathname);
    }else throw Error('Unexpected API '+url.pathname);
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  for(const failure of ['offline','invalidAck'])await check('create-'+failure+'-retains-input-and-releases-busy',async()=>{await fresh();await fillCreate();mode=failure;await createForm().getByRole('button').click();await page.getByRole('alert').filter({hasText:'无法确认知识'}).waitFor();assert.equal(await createForm().locator('[name=title]').inputValue(),'Keep synthetic title');assert.equal(await createForm().getByRole('button').isDisabled(),false);assert.equal(await page.locator('.knowledge-card').count(),1);});
  await check('pending-write-freezes-fields-scope-and-other-actions',async()=>{await fresh();await fillCreate();mode='hold';await createForm().getByRole('button').click();await page.getByRole('button',{name:'正在保存…',exact:true}).waitFor();assert.equal(await createForm().locator('[name=body]').isDisabled(),true);for(const select of await page.locator('.management-toolbar select').all())assert.equal(await select.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'确认沉淀',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'内容策略',exact:true}).isDisabled(),true);releaseWrite();await page.getByRole('heading',{name:'Keep synthetic title',exact:true}).waitFor();assert.equal(await createForm().locator('[name=title]').inputValue(),'');assert.equal(posts.length,1);});
  for(const failure of ['offline','invalidAck'])await check('edit-'+failure+'-keeps-editor-and-original-revision',async()=>{await fresh();await openEditor();mode=failure;await editForm().getByRole('button').click();await page.getByRole('alert').filter({hasText:'无法确认新版本'}).waitFor();assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(await editForm().getByRole('button').isDisabled(),false);assert.equal(posts[0].input.expectedVersion,1);assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);});
  await check('open-editor-keeps-old-snapshot-after-confirmation',async()=>{await fresh();await openEditor();await page.getByRole('button',{name:'确认沉淀',exact:true}).click();await page.getByText('资料已改变，请先复制修改内容').waitFor();await editForm().getByRole('button').click();await page.getByRole('alert').filter({hasText:'本次未保存'}).waitFor();assert.equal(posts[1].input.expectedUpdatedAt,initial.updated_at);assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(item.current_version,1);});
  await check('saved-edit-refresh-failure-is-distinct-from-save-failure',async()=>{await fresh();await openEditor();mode='refreshFailure';await editForm().getByRole('button').click();await page.getByRole('alert').filter({hasText:'知识已保存为新版本'}).waitFor();assert.equal(item.current_version,2);assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(await editForm().getByRole('button').isDisabled(),false);});
  await check('successful-edit-closes-editor-and-refreshes-version',async()=>{await fresh();await openEditor();await editForm().getByRole('button').click();await page.waitForFunction(()=>!document.querySelector('.knowledge-edit-menu').open);assert.equal(item.current_version,2);assert.equal(await page.getByRole('alert').count(),0);});
  await check('confirm-and-archive-use-exact-read-revisions',async()=>{await fresh();await page.getByRole('button',{name:'确认沉淀',exact:true}).click();await page.getByText('已确认',{exact:true}).waitFor();await page.getByRole('button',{name:'归档',exact:true}).click();await page.getByText('已归档',{exact:true}).waitFor();assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);assert.equal(posts[1].input.expectedUpdatedAt,'2026-10-14T00:00:00.001Z');assert.equal(posts[1].input.expectedVersion,1);assert.equal(await page.getByRole('alert').count(),0);});
  await check('strategy-create-network-failure-retains-fields',async()=>{await fresh();await strategyTab();const form=page.locator('.strategy-create form');for(const [name,value]of Object.entries({name:'Keep strategy name',positioning:'Keep positioning',targetAudience:'Audience',painPoints:'Pain',pillars:'Pillar',objectives:'Goal'}))await form.locator(`[name=${name}]`).fill(value);mode='offline';await form.getByRole('button').click();await page.getByRole('alert').filter({hasText:'无法确认策略是否已保存'}).waitFor();assert.equal(await form.locator('[name=name]').inputValue(),'Keep strategy name');assert.equal(await form.getByRole('button').isDisabled(),false);assert.equal(posts[0].input.topicMix.reduce((sum,row)=>sum+row.ratio,0),100);});
  await check('strategy-activation-invalid-ack-releases-busy-without-local-activation',async()=>{await fresh();await strategyTab();mode='invalidAck';await page.getByRole('button',{name:'启用此版本',exact:true}).click();await page.getByRole('alert').filter({hasText:'无法确认策略启用结果'}).waitFor();assert.equal(await page.getByRole('button',{name:'启用此版本',exact:true}).isDisabled(),false);assert.equal(posts[0].input.expectedVersion,2);assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);assert.equal(strategy.status,'draft');});
  await check('strategy-activation-refreshes-current-stamp',async()=>{await fresh();await strategyTab();await page.getByRole('button',{name:'启用此版本',exact:true}).click();await page.getByText('当前启用',{exact:true}).waitFor();assert.equal(await page.getByRole('alert').count(),0);assert.equal(strategy.updated_at,'2026-10-14T00:00:00.003Z');});
  await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:true,synthetic:true,checks,boundary:'Production KnowledgeWorkspace in Edge with intercepted synthetic APIs; UI acknowledgement, input preservation and revision payloads only, not real business or D1.'},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,evidence:path.join(fixture,'report.json')}));
}catch(error){await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));throw error;}
finally{await browser?.close();await server.close();}
