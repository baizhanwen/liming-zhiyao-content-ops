import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { withModelRequestDeadline, ModelDeadlineError } from "../lib/model-request-deadline.ts";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const usage = { prompt_tokens:12,completion_tokens:8,total_tokens:20 };
const expectedUsage = { inputTokens:12,outputTokens:8,totalTokens:20,usageKnown:true };
const config = { provider:"synthetic",model:"synthetic",baseUrl:"https://model.example.invalid",apiKey:"synthetic-only" };

function adapter(t,kind,fetchImpl) {
  const f=runtimeFixture(t);
  f.mockModule("cloudflare:workers",{env:{DELIVERY_MODE:"1",FIRST_RUN_SETUP_CODE:"synthetic-test-code",CONTENT_MODEL_API_KEY:config.apiKey,CONTENT_MODEL_BASE_URL:config.baseUrl,CONTENT_MODEL_NAME:config.model,CONTENT_MODEL_PROVIDER:config.provider,CONTENT_MODEL_ALLOWED_PROVIDERS:config.provider,CONTENT_MODEL_ALLOWED_MODELS:config.model}});
  t.mock.method(globalThis,"fetch",fetchImpl);
  const adapterModule=f.load(kind==="content"?"lib/model-adapter.ts":"lib/project-assistant-model.ts");
  return {f,invoke:()=>kind==="content"?adapterModule.invokeContentModel({system:"Synthetic",user:"Synthetic",profile:"max"})
    :adapterModule.invokeProjectAssistantModel({system:"Synthetic",user:"Synthetic"},{config,fetchImpl})};
}

for(const kind of ["content","assistant"]) {
  test(`${kind}: timeout while reading JSON remains a timeout`,async t=>{
    t.mock.timers.enable({apis:["setTimeout"]});let calls=0,reading;
    const started=new Promise(resolve=>{reading=resolve;});
    const a=adapter(t,kind,async (_url,{signal})=>{calls++;return {ok:true,status:200,json:()=>{reading();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("Synthetic body abort","AbortError")),{once:true}));}};});
    const pending=a.invoke().catch(error=>error);await started;t.mock.timers.tick(90_000);
    const error=await pending;assert.equal(error.code,kind==="content"?"MODEL_TIMEOUT":"PROJECT_ASSISTANT_TIMEOUT");assert.equal(calls,1);
  });
  test(`${kind}: deadline settles even when transport ignores abort`,async t=>{
    t.mock.timers.enable({apis:["setTimeout"]});let signal,calls=0;
    const a=adapter(t,kind,async (_url,options)=>{calls++;signal=options.signal;return new Promise(()=>{});});
    const pending=a.invoke().catch(error=>error);t.mock.timers.tick(90_000);
    for(let i=0;i<10;i++)await Promise.resolve();
    const error=await Promise.race([pending,Promise.resolve("still pending")]);
    assert.equal(error.code,kind==="content"?"MODEL_TIMEOUT":"PROJECT_ASSISTANT_TIMEOUT");assert.equal(signal.aborted,true);assert.equal(calls,1);
  });
  test(`${kind}: rejected provider response retains its known usage`,async t=>{
    const a=adapter(t,kind,async()=>({ok:true,status:200,json:async()=>({usage,choices:[{message:{content:""}}]})}));
    const error=await a.invoke().catch(error=>error);assert.equal(error.code,kind==="content"?"MODEL_EMPTY_RESPONSE":"PROJECT_ASSISTANT_EMPTY_RESPONSE");assert.deepEqual(error.modelUsage,expectedUsage);
  });
}

test("truncated content response retains usage despite invalid output",async t=>{
  const a=adapter(t,"content",async()=>({ok:true,status:200,json:async()=>({usage,choices:[{finish_reason:"length",message:{content:"{"}}]})}));
  const error=await a.invoke().catch(error=>error);assert.equal(error.code,"MODEL_OUTPUT_TRUNCATED");assert.deepEqual(error.modelUsage,expectedUsage);
});

test("failed recorded request saves provider-reported tokens instead of unknown",async t=>{
  const a=adapter(t,"content",async()=>({ok:true,status:200,json:async()=>({usage,choices:[{message:{content:""}}]})})),f=a.f,owner=await f.initialize();
  f.identity.userId=owner.userId;const project=crypto.randomUUID(),now=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Synthetic','Synthetic',?,?,?,?)").run(project,owner.organizationId,owner.userId,owner.userId,now,now);
  const id=crypto.randomUUID(),ledger=[];
  await assert.rejects(f.load("lib/recorded-content-model.ts").invokeRecordedContentRequest({system:"Synthetic",user:"Synthetic",profile:"max"},{id,rootCallId:"other-root",organizationId:owner.organizationId,projectId:project,topicId:null,promptTemplateId:null,promptVersion:"synthetic",provider:config.provider,model:config.model,userId:owner.userId,step:"synthetic",inputHash:"synthetic",inputJson:"{}",monthlyLimit:1000,ledger}),{code:"MODEL_EMPTY_RESPONSE"});
  assert.deepEqual({inputTokens:ledger[0].inputTokens,outputTokens:ledger[0].outputTokens,totalTokens:ledger[0].totalTokens,usageKnown:ledger[0].usageKnown},expectedUsage);
  const row=f.sqlite.prepare("SELECT status,output_json FROM model_calls WHERE id=?").get(id);assert.equal(row.status,"failed");assert.equal(JSON.parse(row.output_json).modelRequests[0].totalTokens,20);
});


test("actual local HTTP dripping body cannot keep a bounded request alive",{timeout:10000},async t=>{
  let requests=0;const timers=new Set();
  const server=createServer((_request,response)=>{requests++;response.writeHead(200,{"content-type":"application/json"});response.flushHeaders();response.write("{");const timer=setInterval(()=>response.write(" "),10);timers.add(timer);response.on("close",()=>{clearInterval(timer);timers.delete(timer);});});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{for(const timer of timers)clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const start=performance.now();
  await assert.rejects(withModelRequestDeadline(1000,async signal=>{const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal});return response.json();}),ModelDeadlineError);
  assert.ok(performance.now()-start<5000);assert.equal(requests,1);
});


for(const failed of [false,true])test(`recovered request retains late ${failed?"rejected":"successful"} usage without reviving its state`,async t=>{
  const f=runtimeFixture(t),owner=await f.initialize(),project=crypto.randomUUID(),now=new Date().toISOString(),id=crypto.randomUUID(),ledger=[];
  f.identity.userId=owner.userId;f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Synthetic','Synthetic',?,?,?,?)").run(project,owner.organizationId,owner.userId,owner.userId,now,now);
  const invoke=f.load("lib/recorded-content-model.ts").invokeRecordedContentRequest,RequestError=f.load("lib/model-adapter.ts").ModelRequestError;
  const operation=async()=>{f.sqlite.prepare("UPDATE model_calls SET status='failed',error_code='WEB_PROCESS_INTERRUPTED',error_message='Keep reason',output_json='{\"sentinel\":true}' WHERE id=?").run(id);if(failed)throw new RequestError("Synthetic empty output","MODEL_EMPTY_RESPONSE",{usage});return {provider:'synthetic',model:'synthetic',profile:'max',latencyMs:1,content:'Synthetic',raw:{usage}};};
  await assert.rejects(invoke({system:'Synthetic',user:'Synthetic',profile:'max'},{id,rootCallId:'other',organizationId:owner.organizationId,projectId:project,topicId:null,promptTemplateId:null,promptVersion:'synthetic',provider:'synthetic',model:'synthetic',userId:owner.userId,step:'synthetic',inputHash:'synthetic',inputJson:'{}',monthlyLimit:1000,ledger},operation),{code:'MODEL_REQUEST_INTERRUPTED'});
  const row=f.sqlite.prepare('SELECT * FROM model_calls WHERE id=?').get(id);assert.equal(row.status,'failed');assert.equal(row.error_code,'WEB_PROCESS_INTERRUPTED');assert.equal(row.error_message,'Keep reason');assert.equal(JSON.parse(row.output_json).sentinel,true);assert.equal(JSON.parse(row.output_json).modelRequests[0].totalTokens,20);
});
