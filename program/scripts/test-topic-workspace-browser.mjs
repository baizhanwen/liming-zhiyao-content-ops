import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root=fileURLToPath(new URL('..',import.meta.url)),fixture=path.join(root,'.local/topic-workspace-browser',Date.now().toString());
await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixture,'entry.tsx'),'import React from "react";import {createRoot} from "react-dom/client";import {TopicWorkspace} from "../../../components/TopicWorkspace";import "../../../app/globals.css";const q=new URLSearchParams(location.search);createRoot(document.getElementById("root")!).render(<TopicWorkspace initialOrganizationId="org" initialProjectId="project" initialTopicId={q.get("topicId") ?? ""} sourceVideoId={q.get("videoId") ?? ""} inspirationCardId={q.get("cardId") ?? ""}/>);');
const {chromium}=await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE||path.join(root,'.local/ecommerce-browser/node_modules/playwright/index.mjs')).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});
const topic={id:'existing-topic',title:'Synthetic topic',angle:null,source_type:'manual',source_ref:null,pillar:null,audience:null,objective:null,hook:null,rationale:null,priority:50,status:'idea',created_at:'2026-10-14T00:00:00Z',updated_at:'2026-10-14T00:00:00.001Z'};
let browser,page,mode='normal',releaseWrite,posts=[],errors=[],writes=[];
const checks=[];
const check=async(name,action)=>{await action();checks.push({name,passed:true});console.log('PASS '+name);};
const viewButton = name => page.getByRole('group', {name: '选题工作区'}).getByRole('button', {name, exact: true});
async function fresh(view='list', query='', fixtureMode='normal'){
  mode=fixtureMode; posts=[]; writes=[]; errors=[];
  await page.goto(server.resolvedUrls.local[0]+query);
  await page.getByRole('combobox',{name:'企业空间',exact:true}).waitFor();
  if(view==='create') await viewButton('新建选题').click();
}
const title=()=>page.getByLabel('选题标题',{exact:true});
const submit=()=>page.getByRole('button',{name:'创建选题',exact:true});
async function fill(){await title().fill('Preserve this synthetic title');await page.locator('textarea[name=angle]').fill('Preserve this synthetic angle');}
async function confirmDelete(){await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByLabel('输入完整选题标题以确认',{exact:true}).fill(topic.title);}
try {
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.LAN_TEST_BROWSER || (process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();let body,status=200;
    if(url.pathname==='/api/organizations')body={organizations:[{id:'org',name:'Synthetic company'},{id:'other',name:'Other company'}]};
    else if(url.pathname==='/api/projects')body={projects:[{id:'project',name:'Synthetic space'},{id:'second',name:'Second space'}],organizationRole:'admin'};
    else if(url.pathname==='/api/knowledge')body={items:[]};
    else if(url.pathname==='/api/topics'&&method==='GET')body={topics:mode==='empty'?[]:[topic],citations:[],canWrite:mode!=='readonly',canDelete:mode!=='readonly',accountBackground:null};
    else if(url.pathname==='/api/inspiration-cards/sample-card')body={history:[{id:'sample-card',title:'灵感标题',core_insight:'灵感角度',status:'confirmed',version:1,expires_at:null}]};
    else if(url.pathname==='/api/topics'&&(method==='POST'||method==='DELETE')) {
      const input=route.request().postDataJSON();posts.push(input);writes.push(method);
      if(mode==='offline'){await route.abort('internetdisconnected');return;}
      if(mode==='hold')await new Promise(resolve=>{releaseWrite=resolve;});
      if(mode==='conflict'){status=409;body={error:{code:'TOPIC_SOURCE_CHANGED',message:'所选资料已改变，本次未保存。请刷新并重新核对。'}};}
      else if(mode==='invalidAck')body={};
      else {status=method==='POST'?201:200;body=method==='POST'?{topic:{...topic,id:'created-topic',title:input.title},citations:[]}:{deleted:{id:input.topicId}};}
    } else throw Error('Unexpected fixture API '+url.pathname);
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await check('create-network-failure-retains-input-and-releases-busy',async()=>{await fresh('create');await fill();mode='offline';await submit().click();await page.getByRole('alert').filter({hasText:'核对'}).waitFor();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.equal(await page.locator('textarea[name=angle]').inputValue(),'Preserve this synthetic angle');assert.deepEqual(errors,[]);});
  await check('invalid-create-ack-retains-input-and-explains-uncertainty',async()=>{await fresh('create');await fill();mode='invalidAck';await submit().click();await page.getByRole('alert').filter({hasText:'确认选题'}).waitFor();assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.equal(await submit().isDisabled(),false);assert.equal(await page.locator('.topic-list article').count(),1);assert.deepEqual(errors,[]);});
  await check('source-conflict-retains-input-and-shows-next-action',async()=>{await fresh('create');await fill();mode='conflict';await submit().click();await page.getByRole('alert').filter({hasText:'重新核对'}).waitFor();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.deepEqual(errors,[]);});
  await check('pending-create-freezes-scope-fields-and-other-writes',async()=>{await fresh('create');await fill();mode='hold';await submit().click();await page.waitForFunction(()=>document.querySelector('.primary-button')?.textContent.includes('正在创建'));assert.equal(await title().isDisabled(),true);for(const select of await page.locator('.management-toolbar select').all())assert.equal(await select.isDisabled(),true);assert.equal(await viewButton('选题池').isDisabled(),true);releaseWrite();await page.getByRole('heading',{name:'Preserve this synthetic title',exact:true}).waitFor();await viewButton('新建选题').click();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'');assert.deepEqual(writes,['POST']);assert.deepEqual(errors,[]);});
  await check('delete-posts-exact-read-revision-and-preserves-title-confirmation',async()=>{await fresh();await confirmDelete();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(posts[0].expectedUpdatedAt,topic.updated_at);assert.equal(posts[0].confirmationTitle,topic.title);assert.equal(await page.locator('.topic-list article').count(),0);assert.deepEqual(errors,[]);});
  await check('delete-network-failure-retains-confirmation-and-releases-busy',async()=>{await fresh();await confirmDelete();mode='offline';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alert').filter({hasText:'删除状态尚未确认'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),false);assert.equal(await page.getByLabel('输入完整选题标题以确认',{exact:true}).inputValue(),topic.title);assert.equal(await page.locator('.topic-list article').count(),1);assert.deepEqual(errors,[]);});
  await check('invalid-delete-ack-keeps-topic-and-dialog',async()=>{await fresh();await confirmDelete();mode='invalidAck';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alert').filter({hasText:'确认选题是否已删除'}).waitFor();assert.equal(await page.locator('.topic-list article').count(),1);assert.equal(await page.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),false);assert.deepEqual(errors,[]);});
  await check('pending-delete-freezes-scope-and-cannot-close-confirmation',async()=>{await fresh();await confirmDelete();mode='hold';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('button',{name:'正在删除…',exact:true}).waitFor();for(const select of await page.locator('.management-toolbar select').all())assert.equal(await select.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);releaseWrite();await page.getByRole('dialog').waitFor({state:'hidden'});assert.deepEqual(errors,[]);});
  await check('topic-views-use-main-area-and-preserve-unsubmitted-input',async()=>{
    await page.setViewportSize({width:1440,height:900});
    await fresh();
    assert.equal(await viewButton('选题池').getAttribute('aria-pressed'),'true');
    assert.equal(await title().isVisible(),false);
    await viewButton('新建选题').click();await fill();
    const form=await page.locator('.topic-create').boundingBox(),area=await page.locator('.topic-layout').boundingBox();
    assert.ok(form && area && Math.abs(form.width-area.width)<1);
    await viewButton('选题池').click();await page.getByRole('heading',{name:topic.title,exact:true}).waitFor();
    await viewButton('新建选题').click();assert.equal(await title().inputValue(),'Preserve this synthetic title');
    assert.equal(await page.locator('textarea[name=angle]').inputValue(),'Preserve this synthetic angle');
  });
  await check('source-links-open-the-form-and-record-links-open-the-pool',async()=>{
    await fresh('auto','?videoId=sample-video');
    await page.getByRole('heading',{name:'从视频分析创建选题',exact:true}).waitFor();
    await fresh('auto','?cardId=sample-card');
    await page.getByRole('heading',{name:'从灵感创建选题',exact:true}).waitFor();
    assert.equal(await title().inputValue(),'灵感标题');
    assert.equal(await page.locator('textarea[name=rationale]').inputValue(),'灵感角度');
    await fresh('auto','?topicId=existing-topic&videoId=sample-video');
    await page.locator('#topic-existing-topic.studio-selected-record').waitFor();
    assert.equal(await viewButton('选题池').getAttribute('aria-pressed'),'true');
  });
  await check('empty-project-opens-the-form-and-readonly-shows-just-the-list',async()=>{
    await fresh('auto','','empty');await title().waitFor();
    await fresh('auto','?videoId=sample-video','readonly');
    await page.getByRole('heading',{name:topic.title,exact:true}).waitFor();
    assert.equal(await viewButton('新建选题').count(),0);
    assert.equal(await title().count(),0);
  });
  await check('mobile-topic-layout-has-no-horizontal-overflow',async()=>{await page.setViewportSize({width:390,height:844});await fresh('create');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:path.join(fixture,'mobile.png')});assert.deepEqual(errors,[]);});
  await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:true,synthetic:true,checks,boundary:'Actual production TopicWorkspace in Chromium, APIs intercepted; confirms UI states and payloads, not real employees, D1, provider billing or business acceptance.'},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,evidence:path.join(fixture,'report.json')}));
} catch(error) {await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));throw error;}
finally {await browser?.close();await server.close();}
