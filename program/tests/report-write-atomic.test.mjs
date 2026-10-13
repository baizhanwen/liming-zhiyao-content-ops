import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(), project = crypto.randomUUID();
  f.identity.userId = owner.userId;
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?, 'Synthetic','Synthetic',?,?,?,?)")
    .run(project,owner.organizationId,owner.userId,owner.userId,"2026-10-01T00:00:00Z","2026-10-01T00:00:00Z");
  f.runtime.getProjectAccess = async () => ({ userId:owner.userId,organizationId:owner.organizationId,projectId:project,organizationRole:"admin",projectRole:null });
  f.runtime.canWriteProjectAccess = () => true;
  const input = { organizationId:owner.organizationId,projectId:project,reportType:"custom",periodStart:"2026-10-01",periodEnd:"2026-10-02" };
  const request = (body=input) => new Request("http://localhost/report",{method:"POST",body:JSON.stringify(body)});
  const generate = (kind,employeeUserId=owner.userId) => f.load(kind === "enterprise" ? "app/api/reports/route.ts" : "app/api/employee-reports/route.ts")
    .POST(request(kind === "enterprise" ? input : {...input,employeeUserId}));
  const finalize = (id,expectedUpdatedAt) => {
    const body={organizationId:input.organizationId,projectId:input.projectId,expectedUpdatedAt};
    // Exercise the old UI contract on the unmodified baseline as well.
    if(!f.load("lib/performance-analytics.ts").finalizeReportSchema.safeParse(body).success)delete body.expectedUpdatedAt;
    return f.load("app/api/reports/[reportId]/finalize/route.ts").POST(request(body),{params:Promise.resolve({reportId:id})});
  };
  const state = () => Object.fromEntries(["performance_reports","employee_work_reports","audit_logs"].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  function beforeWrite(action) {
    let done=false;
    const runOnce=()=>{if(!done){done=true;action();}};
    const batch=f.db.batch; f.db.batch=async statements=>{runOnce();return batch(statements);};
    const prepare=f.db.prepare; f.db.prepare=sql=>{const s=prepare(sql);if(/^(?:UPDATE|INSERT INTO) (?:performance_reports|employee_work_reports)/.test(sql)){const run=s.run;s.run=async()=>{runOnce();return run();};}return s;};
  }
  return {...f,owner,project,input,request,generate,finalize,state,beforeWrite};
}

for (const kind of ["enterprise","employee"]) for (const existing of [false,true]) {
  test(`${kind}: audit failure rolls back ${existing ? "refresh" : "creation"}`,async t=>{
    const f=await fixture(t);if(existing)assert.equal((await f.generate(kind)).status,201);
    const before=f.state(),action=kind==="enterprise"?"performance.report.generated":"employee.report.generated";
    f.sqlite.exec(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic report audit failure'); END`);
    assert.equal((await f.generate(kind)).status,500);assert.deepEqual(f.state(),before);
  });
}

test("finalization audit failure preserves the draft",async t=>{
  const f=await fixture(t),r=await (await f.generate("enterprise")).json(),before=f.state();
  f.sqlite.exec("CREATE TRIGGER synthetic_finalize_failure BEFORE INSERT ON audit_logs WHEN NEW.action='performance.report.finalized' BEGIN SELECT RAISE(ABORT,'synthetic final audit failure'); END");
  assert.equal((await f.finalize(r.report.id,r.report.updated_at)).status,500);assert.deepEqual(f.state(),before);
});

test("generation after concurrent finalization reports conflict and writes no generation audit",async t=>{
  const f=await fixture(t),r=await (await f.generate("enterprise")).json();
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE performance_reports SET status='final',updated_at='2026-10-15T00:00:00Z' WHERE id=?").run(r.report.id));
  assert.equal((await f.generate("enterprise")).status,409);
  assert.equal(f.sqlite.prepare("SELECT status FROM performance_reports WHERE id=?").get(r.report.id).status,"final");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='performance.report.generated'").get().n,1);
});

for(const kind of ["enterprise","employee"]) {
  test(`${kind}: overlapping refresh preserves the winning version`,async t=>{
    const f=await fixture(t),r=await (await f.generate(kind)).json(),table=kind==="enterprise"?"performance_reports":"employee_work_reports";
    f.beforeWrite(()=>f.sqlite.prepare(`UPDATE ${table} SET title='Concurrent winner',updated_at='2026-10-15T00:00:00Z' WHERE id=?`).run(r.report.id));
    assert.equal((await f.generate(kind)).status,409);
    assert.equal(f.sqlite.prepare(`SELECT title FROM ${table} WHERE id=?`).get(r.report.id).title,"Concurrent winner");
  });
  test(`${kind}: duplicate creation is a conflict rather than a database failure`,async t=>{
    const f=await fixture(t),table=kind==="enterprise"?"performance_reports":"employee_work_reports";
    const existing=await (await f.generate(kind)).json(),row=f.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(existing.report.id);
    f.sqlite.prepare(`DELETE FROM ${table}`).run();
    f.beforeWrite(()=>f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row)}) VALUES(${Object.keys(row).map(()=>"?")})`).run(...Object.values(row)));
    assert.equal((await f.generate(kind)).status,409);assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
  });
}

test("finalization requires the version the user actually reviewed",async t=>{
  const f=await fixture(t),r=await (await f.generate("enterprise")).json();
  f.sqlite.prepare("UPDATE performance_reports SET updated_at='2026-10-15T00:00:00Z' WHERE id=?").run(r.report.id);
  assert.equal((await f.finalize(r.report.id,r.report.updated_at)).status,409);
  assert.equal(f.sqlite.prepare("SELECT status FROM performance_reports WHERE id=?").get(r.report.id).status,"draft");
});

for(const kind of ["enterprise","employee"]) {
  test(`${kind}: authority removed at transaction entry prevents report and audit writes`,async t=>{
    const f=await fixture(t),before=f.state();
    f.beforeWrite(()=>f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.owner.userId));
    assert.equal((await f.generate(kind)).status,403);assert.deepEqual(f.state(),before);
  });
}


test("finalization without a reviewed version is rejected",async t=>{
  const f=await fixture(t),r=await (await f.generate("enterprise")).json();
  const response=await f.load("app/api/reports/[reportId]/finalize/route.ts").POST(f.request({organizationId:f.owner.organizationId,projectId:f.project}),{params:Promise.resolve({reportId:r.report.id})});
  assert.equal(response.status,400);
  assert.equal(f.sqlite.prepare("SELECT status FROM performance_reports WHERE id=?").get(r.report.id).status,"draft");
});


for(const kind of ["enterprise","employee"]) for(const refresh of [false,true]) {
  test(`${kind}: lost acknowledgement reconciles ${refresh?"refresh":"creation"} without replay`,async t=>{
    const f=await fixture(t);if(refresh)await f.generate(kind);
    const batch=f.db.batch;let attempts=0;f.db.batch=async statements=>{attempts++;await batch(statements);throw new Error("synthetic lost acknowledgement");};
    const response=await f.generate(kind);assert.equal(response.status,refresh?200:201);assert.equal(attempts,1);
    const r=await response.json(),table=kind==="enterprise"?"performance_reports":"employee_work_reports";
    assert.equal(f.sqlite.prepare(`SELECT updated_at FROM ${table} WHERE id=?`).get(r.report.id).updated_at,r.report.updated_at);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_id=?").get(r.report.id).n,refresh?2:1);
  });
}

test("finalization lost acknowledgement reconciles exactly one committed audit",async t=>{
  const f=await fixture(t),r=await (await f.generate("enterprise")).json(),batch=f.db.batch;
  f.db.batch=async statements=>{await batch(statements);throw new Error("synthetic final receipt lost");};
  assert.equal((await f.finalize(r.report.id,r.report.updated_at)).status,200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='performance.report.finalized'").get().n,1);
  assert.equal((await f.finalize(r.report.id,r.report.updated_at)).status,409);
});

for(const committed of [false,true])test(`unreadable receipt reports unknown status after ${committed?"committed":"failed"} transaction`,async t=>{
  const f=await fixture(t),batch=f.db.batch,prepare=f.db.prepare;
  f.db.batch=async statements=>{if(committed)await batch(statements);throw new Error("synthetic transport failure");};
  f.db.prepare=sql=>{const s=prepare(sql);if(sql.startsWith("SELECT id FROM audit_logs"))s.first=async()=>{throw new Error("synthetic receipt read unavailable");};return s;};
  const response=await f.generate("enterprise");assert.equal(response.status,503);assert.equal((await response.json()).error.code,"REPORT_WRITE_STATUS_UNKNOWN");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM performance_reports").get().n,committed?1:0);
});

for(const kind of ["enterprise","employee"])test(`${kind}: logout at transaction entry prevents report and audit`,async t=>{
  const f=await fixture(t),hash=await f.runtime.sha256Hex(new TextEncoder().encode("synthetic-token"));
  f.sqlite.prepare("INSERT INTO local_sessions(id,user_id,token_hash,expires_at,last_seen_at,created_at) VALUES('synthetic-session',?,?,'2099-01-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run(f.owner.userId,hash);
  const base=f.request(),request=new Request(base,{headers:{cookie:"liming_session=synthetic-token"}});
  f.beforeWrite(()=>f.sqlite.prepare("DELETE FROM local_sessions").run());
  const body=kind==="enterprise"?f.input:{...f.input,employeeUserId:f.owner.userId};
  const response=await f.load(kind==="enterprise"?"app/api/reports/route.ts":"app/api/employee-reports/route.ts").POST(new Request(request,{body:JSON.stringify(body)}));
  assert.equal(response.status,403);assert.equal(f.state().performance_reports.length+f.state().employee_work_reports.length,0);
});

function addEmployee(f) {
  const id=crypto.randomUUID(),now="2026-10-01T00:00:00Z";
  f.sqlite.prepare("INSERT INTO users(id,auth_subject,email,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(id,id,id+"@example.invalid",now,now);
  f.sqlite.prepare("INSERT INTO organization_members(id,organization_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'member','active',?,?,?,?)").run(crypto.randomUUID(),f.owner.organizationId,id,f.owner.userId,f.owner.userId,now,now);
  f.sqlite.prepare("INSERT INTO project_members(id,organization_id,project_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'member','active',?,?,?,?)").run(crypto.randomUUID(),f.owner.organizationId,f.project,id,f.owner.userId,f.owner.userId,now,now);
  return id;
}

test("employee report refuses a target removed during calculation",async t=>{
  const f=await fixture(t),employee=addEmployee(f);
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(employee));
  assert.equal((await f.generate("employee",employee)).status,404);assert.equal(f.state().employee_work_reports.length,0);
});

test("an administrator downgraded during calculation cannot save another employee's report",async t=>{
  const f=await fixture(t),employee=addEmployee(f),now="2026-10-01T00:00:00Z";
  f.sqlite.prepare("INSERT INTO project_members(id,organization_id,project_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('synthetic-owner-member',?,?,?,'member','active',?,?,?,?)").run(f.owner.organizationId,f.project,f.owner.userId,f.owner.userId,f.owner.userId,now,now);
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE organization_members SET role='member' WHERE user_id=?").run(f.owner.userId));
  assert.equal((await f.generate("employee",employee)).status,403);assert.equal(f.state().employee_work_reports.length,0);
});

test("report revisions advance even when the previous revision is ahead of the clock",async t=>{
  const f=await fixture(t),previous="2098-01-01T00:00:00.000Z";
  assert.equal(f.load("lib/report-write-transaction.ts").nextReportVersion(previous),"2098-01-01T00:00:00.001Z");
});
