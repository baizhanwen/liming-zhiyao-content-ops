import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root=fileURLToPath(new URL('..',import.meta.url)),fixture=path.join(root,'.local/topic-workspace-browser',Date.now().toString());
await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
await writeFile(path.join(fixture,'entry.tsx'),'import React from "react";import {createRoot} from "react-dom/client";import {TopicWorkspace} from "../../../components/TopicWorkspace";import "../../../app/globals.css";createRoot(document.getElementById("root")!).render(<TopicWorkspace initialOrganizationId="org" initialProjectId="project"/>);');
const {chromium}=await import(pathToFileURL(process.env.LAN_TEST_PLAYWRIGHT_MODULE||path.join(root,'.local/ecommerce-browser/node_modules/playwright/index.mjs')).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});
const topic={id:'existing-topic',title:'Synthetic topic',angle:null,source_type:'manual',source_ref:null,pillar:null,audience:null,objective:null,hook:null,rationale:null,priority:50,status:'idea',created_at:'2026-10-14T00:00:00Z',updated_at:'2026-10-14T00:00:00.001Z'};
let browser,page,mode='normal',releaseWrite,posts=[],errors=[],writes=[];
const checks=[];
const check=async(name,action)=>{await action();checks.push({name,passed:true});console.log('PASS '+name);};
async function fresh(){mode='normal';posts=[];writes=[];errors=[];await page.goto(server.resolvedUrls.local[0]);await page.getByLabel('选题标题',{exact:true}).waitFor();}
const title=()=>page.getByLabel('选题标题',{exact:true});
const submit=()=>page.getByRole('button',{name:'创建选题',exact:true});
async function fill(){await title().fill('Preserve this synthetic title');await page.locator('textarea[name=angle]').fill('Preserve this synthetic angle');}
async function confirmDelete(){await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByLabel('输入完整选题标题以确认',{exact:true}).fill(topic.title);}
try {
  await server.listen();browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();let body,status=200;
    if(url.pathname==='/api/organizations')body={organizations:[{id:'org',name:'Synthetic company'},{id:'other',name:'Other company'}]};
    else if(url.pathname==='/api/projects')body={projects:[{id:'project',name:'Synthetic space'},{id:'second',name:'Second space'}],organizationRole:'admin'};
    else if(url.pathname==='/api/knowledge')body={items:[]};
    else if(url.pathname==='/api/topics'&&method==='GET')body={topics:[topic],citations:[],canWrite:true,canDelete:true,accountBackground:null};
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
  await check('create-network-failure-retains-input-and-releases-busy',async()=>{await fresh();await fill();mode='offline';await submit().click();await page.getByRole('alert').filter({hasText:'核对'}).waitFor();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.equal(await page.locator('textarea[name=angle]').inputValue(),'Preserve this synthetic angle');assert.deepEqual(errors,[]);});
  await check('invalid-create-ack-retains-input-and-explains-uncertainty',async()=>{await fresh();await fill();mode='invalidAck';await submit().click();await page.getByRole('alert').filter({hasText:'确认选题'}).waitFor();assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.equal(await submit().isDisabled(),false);assert.equal(await page.locator('.topic-list article').count(),1);assert.deepEqual(errors,[]);});
  await check('source-conflict-retains-input-and-shows-next-action',async()=>{await fresh();await fill();mode='conflict';await submit().click();await page.getByRole('alert').filter({hasText:'重新核对'}).waitFor();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'Preserve this synthetic title');assert.deepEqual(errors,[]);});
  await check('pending-create-freezes-scope-fields-and-other-writes',async()=>{await fresh();await fill();mode='hold';await submit().click();await page.waitForFunction(()=>document.querySelector('.primary-button')?.textContent.includes('正在创建'));assert.equal(await title().isDisabled(),true);for(const select of await page.locator('.management-toolbar select').all())assert.equal(await select.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);releaseWrite();await page.getByRole('heading',{name:'Preserve this synthetic title',exact:true}).waitFor();assert.equal(await submit().isDisabled(),false);assert.equal(await title().inputValue(),'');assert.deepEqual(writes,['POST']);assert.deepEqual(errors,[]);});
  await check('delete-posts-exact-read-revision-and-preserves-title-confirmation',async()=>{await fresh();await confirmDelete();await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(posts[0].expectedUpdatedAt,topic.updated_at);assert.equal(posts[0].confirmationTitle,topic.title);assert.equal(await page.locator('.topic-list article').count(),0);assert.deepEqual(errors,[]);});
  await check('delete-network-failure-retains-confirmation-and-releases-busy',async()=>{await fresh();await confirmDelete();mode='offline';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alert').filter({hasText:'删除状态尚未确认'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),false);assert.equal(await page.getByLabel('输入完整选题标题以确认',{exact:true}).inputValue(),topic.title);assert.equal(await page.locator('.topic-list article').count(),1);assert.deepEqual(errors,[]);});
  await check('invalid-delete-ack-keeps-topic-and-dialog',async()=>{await fresh();await confirmDelete();mode='invalidAck';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('alert').filter({hasText:'确认选题是否已删除'}).waitFor();assert.equal(await page.locator('.topic-list article').count(),1);assert.equal(await page.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),false);assert.deepEqual(errors,[]);});
  await check('pending-delete-freezes-scope-and-cannot-close-confirmation',async()=>{await fresh();await confirmDelete();mode='hold';await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.getByRole('button',{name:'正在删除…',exact:true}).waitFor();for(const select of await page.locator('.management-toolbar select').all())assert.equal(await select.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);releaseWrite();await page.getByRole('dialog').waitFor({state:'hidden'});assert.deepEqual(errors,[]);});
  await check('mobile-topic-layout-has-no-horizontal-overflow',async()=>{await page.setViewportSize({width:390,height:844});await fresh();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:path.join(fixture,'mobile.png')});assert.deepEqual(errors,[]);});
  await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:true,synthetic:true,checks,boundary:'Actual production TopicWorkspace in Edge, APIs intercepted; confirms UI states and payloads, not real employees, D1, provider billing or business acceptance.'},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,evidence:path.join(fixture,'report.json')}));
} catch(error) {await writeFile(path.join(fixture,'report.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));throw error;}
finally {await browser?.close();await server.close();}
