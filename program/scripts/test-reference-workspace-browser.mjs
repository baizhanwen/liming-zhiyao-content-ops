import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root=fileURLToPath(new URL('..',import.meta.url)),fixture=path.join(root,'.local/reference-workspace-browser',Date.now().toString());
await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixture,'entry.tsx'),'import React from "react";import {createRoot} from "react-dom/client";import {KnowledgeWorkspace} from "../../../components/KnowledgeWorkspace";import "../../../app/globals.css";const q=new URLSearchParams(location.search);createRoot(document.getElementById("root")!).render(<KnowledgeWorkspace organizationId="org" projectId="project" projectName="Synthetic space" tab={q.get("tab")==="strategy"?"strategy":"knowledge"}/>);');
await writeFile(path.join(fixture,'link.tsx'),'import React from "react"; export default function Link(props) { return <a {...props}/>; }');
const {chromium}=await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE||path.join(root,'.local/ecommerce-browser/node_modules/playwright/index.mjs')).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],resolve:{alias:{'next/link':path.join(fixture,'link.tsx')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});
const initial={id:'knowledge',title:'Synthetic knowledge',category:'brand_story',body:'Synthetic knowledge body for isolated tests.',source_type:'manual',source_ref:null,status:'draft',current_version:1,confirmed_at:null,updated_at:'2026-10-14T00:00:00.000Z'};
const initialStrategy={id:'strategy',name:'Synthetic strategy',version:2,status:'draft',positioning:'Synthetic position',target_audience:'Synthetic audience',pain_points:['Question'],pillars:['Education'],objectives:['Education'],updated_at:initial.updated_at};
let browser,page,mode='normal',item={...initial},strategy={...initialStrategy},posts=[],errors=[],releaseWrite,refreshFailed=false;
const checks=[];
const check=async(name,fn)=>{await fn();assert.deepEqual(errors,[]);checks.push({name,passed:true});console.log('PASS '+name);};
const createForm = () => page.locator('#knowledge-entry-manual form').filter({has: page.locator('textarea[name=body]')});
const editForm = () => page.locator('#knowledge-editor form');
const saveEdit = () => editForm().getByRole('button', {name:'保存新版本',exact:true});
const knowledgeViews = () => page.getByRole('group', {name:'品牌知识工作区'});
const strategyViews = () => page.getByRole('group', {name:'内容策略工作区'});
const view = label => knowledgeViews().getByRole('button', {name:label});
const strategyForm = () => page.locator('#strategy-entry form');

async function fresh(tab = 'knowledge') {
  mode='normal'; item={...initial}; strategy={...initialStrategy}; posts=[]; errors=[]; refreshFailed=false; releaseWrite=undefined;
  await page.goto(server.resolvedUrls.local[0]+'?tab='+tab);
  await (tab === 'strategy' ? strategyViews() : knowledgeViews()).waitFor();
}
async function fillCreate() {
  await view('填写品牌知识').click();
  await page.getByText('直接填写已有知识正文',{exact:true}).click();
  await createForm().locator('[name=title]').fill('Keep synthetic title');
  await createForm().locator('[name=body]').fill('Keep synthetic body and source before acknowledgement.');
}
async function openEditor() {
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await editForm().locator('[name=body]').fill('Keep modified synthetic body before acknowledgement.');
}
async function assertWide(locator) {
  const dimensions=await locator.evaluate(el=>({field:el.getBoundingClientRect().width,workspace:el.closest('.knowledge-workspace').getBoundingClientRect().width}));
  assert.ok(dimensions.field / dimensions.workspace > .8, JSON.stringify(dimensions));
}
try {
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.LAN_TEST_BROWSER || (process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
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
  await check('pending-write-freezes-fields-and-other-writes-and-keeps-scope',async()=>{
    await fresh(); await fillCreate(); mode='hold'; await createForm().getByRole('button').click();
    await page.waitForFunction(()=>document.querySelector('#knowledge-entry-manual textarea[name="body"]').disabled);
    assert.equal(await createForm().getByRole('button').isDisabled(),true);
    await view(/^已有知识/).click();
    assert.equal(await page.getByRole('button',{name:'确认沉淀',exact:true}).isDisabled(),true);
    await view('填写品牌知识').click();
    assert.equal(await createForm().locator('[name=title]').inputValue(),'Keep synthetic title');
    assert.equal(posts.length,1); assert.equal(posts[0].input.organizationId,'org'); assert.equal(posts[0].input.projectId,'project');
    releaseWrite();
    await page.getByText('已保存为待确认资料。',{exact:true}).waitFor();
    assert.equal(await createForm().locator('[name=title]').inputValue(),'');
    await view(/^已有知识/).click(); await page.getByRole('heading',{name:'Keep synthetic title',exact:true}).waitFor();
  });
  for(const failure of ['offline','invalidAck'])await check('edit-'+failure+'-keeps-editor-and-original-revision',async()=>{await fresh();await openEditor();mode=failure;await saveEdit().click();await page.getByRole('alert').filter({hasText:'无法确认新版本'}).waitFor();assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(await saveEdit().isDisabled(),false);assert.equal(posts[0].input.expectedVersion,1);assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);});
  await check('open-editor-keeps-old-snapshot-after-confirmation',async()=>{await fresh();await openEditor();await view(/^已有知识/).click();await page.getByRole('button',{name:'确认沉淀',exact:true}).click();await page.getByText('已确认',{exact:true}).waitFor();await view('继续编辑').click();await page.getByText('资料已改变，请先复制修改内容').waitFor();await saveEdit().click();await page.getByRole('alert').filter({hasText:'本次未保存'}).waitFor();assert.equal(posts[1].input.expectedUpdatedAt,initial.updated_at);assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(item.current_version,1);});
  await check('saved-edit-refresh-failure-is-distinct-from-save-failure',async()=>{await fresh();await openEditor();mode='refreshFailure';await saveEdit().click();await page.getByRole('alert').filter({hasText:'知识已保存为新版本'}).waitFor();assert.equal(item.current_version,2);assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');assert.equal(await saveEdit().isDisabled(),false);});
  await check('successful-edit-closes-editor-and-refreshes-version',async()=>{await fresh();await openEditor();await saveEdit().click();await editForm().waitFor({state:'detached'});await page.getByRole('heading',{name:initial.title,exact:true}).waitFor();assert.equal(item.current_version,2);assert.equal(await page.getByRole('alert').count(),0);});
  await check('confirm-and-archive-use-exact-read-revisions',async()=>{await fresh();await page.getByRole('button',{name:'确认沉淀',exact:true}).click();await page.getByText('已确认',{exact:true}).waitFor();await page.getByRole('button',{name:'归档',exact:true}).click();await page.getByText('已归档',{exact:true}).waitFor();assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);assert.equal(posts[1].input.expectedUpdatedAt,'2026-10-14T00:00:00.001Z');assert.equal(posts[1].input.expectedVersion,1);assert.equal(await page.getByRole('alert').count(),0);});
  await check('strategy-create-network-failure-retains-questionnaire-answers',async()=>{
    await fresh('strategy');
    await strategyViews().getByRole('button',{name:'填写内容策略'}).click();
    const form=strategyForm();
    await form.locator('[name=audience]').selectOption('初学者');
    await form.locator('[name=themes]').fill('教程、校园生活');
    await form.locator('[name=goal]').selectOption('帮助选择');
    mode='offline';
    await form.getByRole('button',{name:'保存策略草稿'}).click();
    await page.getByRole('alert').filter({hasText:'无法确认策略是否已保存'}).waitFor();
    assert.equal(await form.locator('[name=themes]').inputValue(),'教程、校园生活');
    assert.equal(await form.getByRole('button',{name:'保存策略草稿'}).isDisabled(),false);
    assert.deepEqual([posts[0].input.form.themes,posts[0].input.form.audience,posts[0].input.form.goal],['教程、校园生活','初学者','帮助选择']);
  });
  await check('strategy-activation-invalid-ack-releases-busy-without-local-activation',async()=>{await fresh('strategy');mode='invalidAck';await page.getByRole('button',{name:'启用此版本',exact:true}).click();await page.getByRole('alert').filter({hasText:'无法确认策略启用结果'}).waitFor();assert.equal(await page.getByRole('button',{name:'启用此版本',exact:true}).isDisabled(),false);assert.equal(posts[0].input.expectedVersion,2);assert.equal(posts[0].input.expectedUpdatedAt,initial.updated_at);assert.equal(strategy.status,'draft');});
  await check('strategy-activation-refreshes-current-stamp',async()=>{await fresh('strategy');await page.getByRole('button',{name:'启用此版本',exact:true}).click();await page.getByText('当前启用',{exact:true}).waitFor();assert.equal(await page.getByRole('alert').count(),0);assert.equal(strategy.updated_at,'2026-10-14T00:00:00.003Z');});
  await check('material-categories-keep-separate-unsaved-answers-when-hidden', async () => {
    await fresh();
    await view('填写品牌知识').click();
    const category = name => page.getByRole('checkbox', { name, exact: true });
    const answer = kind => page.locator('.guided-material').filter({ has: page.getByRole('heading', { name: kind, exact: true }) }).locator('[name=answer0]');
    const experience = '经历、人物与访谈', footage = '作品、画面与原声';
    await category(experience).check();
    await answer(experience).fill('采访后的复盘');
    await category(footage).check();
    await answer(footage).fill('教室窗外的雨声');
    await category(experience).uncheck();
    assert.equal(await answer(footage).inputValue(), '教室窗外的雨声');
    await category('暂时没有').check();
    assert.equal(await page.locator('.guided-material:visible').count(), 0);
    await category(footage).check();
    await category(experience).check();
    assert.equal(await answer(footage).inputValue(), '教室窗外的雨声');
    assert.equal(await answer(experience).inputValue(), '采访后的复盘');
  });
  await check('knowledge-and-strategy-forms-use-main-workspace-and-restore-drafts',async()=>{
    await fresh(); await fillCreate(); await assertWide(createForm().locator('[name=body]'));
    await view(/^已有知识/).click(); await openEditor(); await assertWide(editForm().locator('[name=body]'));
    await view('填写品牌知识').click(); assert.equal(await createForm().locator('[name=title]').inputValue(),'Keep synthetic title');
    await view('继续编辑').click(); assert.equal(await editForm().locator('[name=body]').inputValue(),'Keep modified synthetic body before acknowledgement.');
    await editForm().getByRole('button',{name:'取消编辑'}).click(); await page.getByRole('heading',{name:initial.title}).waitFor();
    await fresh('strategy'); await strategyViews().getByRole('button',{name:'填写内容策略'}).click(); await assertWide(strategyForm());
    await page.setViewportSize({width:390,height:844});
    assert.ok(await strategyForm().isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  });
  await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:true,synthetic:true,checks,boundary:'Production KnowledgeWorkspace in Chromium with intercepted synthetic APIs; UI acknowledgement, input preservation and revision payloads only, not real business or D1.'},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,evidence:path.join(fixture,'report.json')}));
}catch(error){await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));throw error;}
finally{await browser?.close();await server.close();}
