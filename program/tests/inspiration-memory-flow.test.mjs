import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';
import { readInspirationMemories } from '../lib/inspiration-memory.ts';
import { runProjectAssistantConversationWithDb, createProjectAssistantConversationWithDb, readProjectAssistantMessagesWithDb } from '../lib/project-assistant-conversation.ts';
import { saveProjectAssistantRecommendationsWithDb } from '../lib/project-assistant-cards.ts';
import { enqueueProjectMemoryEventWithDb } from '../lib/project-memory-events.ts';
import * as production from '../lib/content-production.ts';

async function fixture(t) {
 const f=runtimeFixture(t), installation=await f.initialize();
 const scope={organizationId:installation.organizationId,projectId:'memory-project',userId:installation.userId};
 const seed=(table,values)=>{
   const columns=new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
   const row=Object.fromEntries(Object.entries({id:crypto.randomUUID(),organization_id:scope.organizationId,project_id:scope.projectId,created_by:scope.userId,updated_by:scope.userId,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...values}).filter(([key])=>columns.has(key)));
   f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));return row.id;
 };
 seed('projects',{id:scope.projectId,name:'项目',client_name:'账号'});
 seed('projects',{id:'foreign',name:'其他',client_name:'其他'});
 f.mock('lib/project-assistant-model.ts',{ProjectAssistantConfigurationError:class extends Error{}});
 f.mock('lib/content-production.ts',production);
 return {...f,scope,seed,processor:f.load('lib/project-memory-event-processor.ts')};
}

test('only adopted unexpired memories enter inspiration; citations and card lineage retain actual sources',async t=>{
 const f=await fixture(t);
 const text='学习编程时先明确任务的输入和输出，再考虑实现细节。';
 for(const [id,status,project,expires] of [['adopted','confirmed',f.scope.projectId,null],['candidate','candidate',f.scope.projectId,null],['rejected','rejected',f.scope.projectId,null],['expired','confirmed',f.scope.projectId,'2000-01-01'],['foreign','confirmed','foreign',null]]) {
   f.seed('project_memory_items',{id,project_id:project,canonical_key:id,category:'memory',kind:'soft',status,title:id,content:text,content_hash:id,source_type:'manual',expires_at:expires});
 }
 f.seed('project_memory_evidence',{memory_item_id:'adopted',source_type:'video_analysis',source_id:'origin-analysis',quote:text});
 assert.deepEqual((await readInspirationMemories(f.db,{...f.scope,query:'编程'})).map(m=>m.id),['adopted']);
 const conversation=await createProjectAssistantConversationWithDb(f.db,f.scope);
 const result=await runProjectAssistantConversationWithDb(f.db,{...f.scope,conversationId:conversation.id,question:'基于记忆推荐一个编程选题',invoke:async input=>{
   const context=JSON.parse(input.user);
   assert.deepEqual(context.memoryLibrary.map(m=>m.id),['adopted']);
   return {provider:'test',model:'test',content:JSON.stringify({reply:'先看输入输出如何影响任务理解。',memoryCitations:[{memoryId:'adopted',quote:text},{memoryId:'foreign',quote:text},{memoryId:'adopted',quote:'这是不存在于原记忆的伪造引用。'}],recommendations:[{title:'编程前先问清输入输出',coreInsight:'借鉴记忆中先定义任务输入输出的观点，用需求前后对比讲清楚。',memoryIds:['adopted','foreign'],topic:{angle:'对比只给题目和写清输入输出两种项目需求。'}}]})};
 }});
 const suggestion=result.assistantMessage.suggestions[0];
 assert.deepEqual(suggestion.memoryIds,['adopted']);
 assert.equal(result.assistantMessage.memoryCitations.length,1);
 assert.equal(suggestion.topicId,undefined);
 assert.equal(suggestion.memorySources[0].evidence[0].sourceId,'origin-analysis');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM topic_ideas').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_citations WHERE citation_type = 'memory'").get().n,0);
 const transcript=await readProjectAssistantMessagesWithDb(f.db,{...f.scope,conversationId:conversation.id});
 assert.equal(transcript.messages.find(m=>m.role==='assistant').memoryCitations[0].title,'adopted');
 const cards=await saveProjectAssistantRecommendationsWithDb(f.db,{...f.scope,messageId:result.assistantMessage.id,recommendationIndexes:[0]});
 const card=f.sqlite.prepare('SELECT * FROM project_inspiration_cards WHERE id = ?').get(cards[0].id);
 assert.ok(JSON.parse(card.evidence_json).some(e=>e.sourceType==='project_memory'&&e.sourceId==='adopted'));
 assert.ok(JSON.parse(card.evidence_json).some(e=>e.sourceId==='origin-analysis'));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM project_inspiration_card_sources WHERE memory_item_id = ?').get('adopted').n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM topic_ideas').get().n,0);
 f.sqlite.exec("UPDATE project_memory_items SET status = 'expired' WHERE id = 'adopted'");
 assert.deepEqual(await readInspirationMemories(f.db,f.scope),[]);
});

test('extraction receives substantive content and methods, retains attributed content candidates, and rejects fabricated evidence',async t=>{
 const f=await fixture(t), quote='明确验收标准能帮助发现需求描述中的遗漏。';
 f.seed('videos',{id:'video',title:'讲解需求',platform:'douyin',source_type:'url'});
 f.seed('video_library_entries',{id:'library',source_video_id:'video'});
 f.seed('project_video_references',{id:'reference',library_entry_id:'library',purpose:'benchmark',status:'active'});
 f.seed('video_analyses',{id:'analysis',video_id:'video',schema_version:'v1',report_json:JSON.stringify({summary:quote,structure:['先举例再解释']})});
 f.seed('video_knowledge_atoms',{library_entry_id:'library',analysis_id:'analysis',atom_key:'summary-1',atom_type:'summary',title:'需求观点',content:quote,structured_json:'{}',source_locator_json:'{}',report_hash:'report',extractor_version:'v1',status:'active'});
 const event=await enqueueProjectMemoryEventWithDb(f.db,{...f.scope,eventType:'video_analysis_completed',sourceType:'video_analysis',sourceId:'analysis',payload:{}});
 const result=await f.processor.processProjectMemoryEventWithDb(f.db,{...f.scope,eventId:event.event.id,invoke:async input=>{
   assert.match(input.system,/内容启发/);assert.doesNotMatch(input.system,/不属于项目记忆|只能提取可复用的内容生产方法/);
   const source=JSON.parse(input.user).event.source;
   assert.match(source.analysis.content,new RegExp(quote));
   assert.equal(source.benchmarkCorpus[0].observations[0].type,'summary');
   return {provider:'test',model:'test',content:JSON.stringify({memoryOperations:[
     {operation:'add',canonicalKey:'acceptance_content',title:'验收标准帮助发现需求遗漏',content:'来源视频提出：'+quote+'可用于讨论如何交代任务，不是本账号亲身经历。',confidence:90,evidence:[{sourceType:'video_analysis',sourceId:'analysis',quote}]},
     {operation:'add',canonicalKey:'invented',title:'伪造案例',content:'模型伪造了不存在的实验结果和经历。',confidence:90,evidence:[{sourceType:'video_analysis',sourceId:'analysis',quote:'不存在的实验结果证明这套方法有效。'}]},
   ]})};
 }});
 assert.equal(result.status,'completed');
 const memories=f.sqlite.prepare('SELECT * FROM project_memory_items').all();
 assert.equal(memories.length,1);assert.equal(memories[0].status,'candidate');assert.match(memories[0].content,/来源视频提出/);
 assert.equal(f.sqlite.prepare('SELECT prompt_version FROM project_memory_events WHERE id=?').get(event.event.id).prompt_version,f.processor.PROJECT_MEMORY_EXTRACTION_PROMPT_VERSION);
});

test('legacy extraction events are rechecked in bounded batches once per extraction version',async t=>{
 const f=await fixture(t);
 for(let i=0;i<3;i++) {
   const event=await enqueueProjectMemoryEventWithDb(f.db,{...f.scope,eventType:'video_analysis_completed',sourceType:'video_analysis',sourceId:`missing-${i}`,payload:{i}});
   f.sqlite.prepare("UPDATE project_memory_events SET status='completed',prompt_version='old-structure-only' WHERE id=?").run(event.event.id);
 }
 const invoke=async()=>{throw new Error('Unavailable sources must not invoke model');};
 assert.equal((await f.processor.syncProjectMemoryEventsWithDb(f.db,{...f.scope,limit:2,invoke})).length,2);
 assert.equal((await f.processor.syncProjectMemoryEventsWithDb(f.db,{...f.scope,limit:2,invoke})).length,1);
 assert.equal((await f.processor.syncProjectMemoryEventsWithDb(f.db,{...f.scope,limit:2,invoke})).length,0);
});

test('non-inspiration generation contexts reject direct memory sources',async t=>{
 const f=await fixture(t);
 f.runtime.getProjectAccess=async()=>({organizationRole:'admin',projectRole:'admin'});
 f.mock('lib/generation-freeze.mjs.ts',{isGenerationFrozen:()=>false});
 f.seed('content_strategies',{version:1,name:'策略',status:'active',positioning:'面向学习者提供具体方法',target_audience:'学习者',pain_points_json:'[]',pillars_json:'[]',objectives_json:'["教育"]',topic_mix_json:'{}'});
 const {buildProjectGenerationContext}=f.load('lib/project-generation-context.ts');
 for(const capability of ['topic','content','wechat_image','analysis']) {
   const result=await buildProjectGenerationContext({...f.scope,authSubject:'test',capability,sources:[{sourceType:'memory',sourceId:'memory',title:'记忆',text:'不应注入其他生成流程'}]});
   assert.equal(result.ok,false);assert.equal(result.code,'UNSAFE_GENERATION_SOURCE');
 }
});
