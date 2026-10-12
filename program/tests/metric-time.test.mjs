import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { metricUtc, metricTimeKey, metricUtcSql, metricOrderSql } from "../lib/metric-time.ts";
import { buildAnalyticsSnapshot } from "../lib/performance-analytics.ts";
test("SQL and JS preserve equivalent offsets, missing fractions and fine precision", () => {
  const db=new DatabaseSync(":memory:");
  try {
    for(const text of ["2026-10-13T08:00:00+08:00","2026-10-13T00:00:00Z","2026-10-13T00:00Z","2026-10-13T08:00:00.123400+08:00","2026-10-13T00:00:00.9999Z","2026-10-13T00:00:00.1Z","2026-10-13T00:00:00.100Z","2026-10-12T20:30:00-03:30"])
      assert.equal(db.prepare(`SELECT ${metricUtcSql("?")} AS utc`).get(...Array.from({length:(metricUtcSql("?").match(/\?/g)||[]).length},()=>text)).utc,metricUtc(text),text);
  } finally {db.close();}
});
test("chronological keys order prefixes and do not round a late fraction to the next second", () => {
  const values=["2026-10-13T00:00:00.1234Z","2026-10-13T00:00:00.123Z","2026-10-13T00:00:00.9999Z","2026-10-13T00:00:01Z"];
  assert.deepEqual(values.slice().sort((a,b)=>metricTimeKey(a).localeCompare(metricTimeKey(b))),[values[1],values[0],values[2],values[3]]);
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE stamps(value TEXT)");for(const value of values)db.prepare("INSERT INTO stamps VALUES(?)").run(value);
  assert.deepEqual(db.prepare(`SELECT value FROM stamps ORDER BY ${metricOrderSql("value")}`).all().map(r=>r.value),[values[1],values[0],values[2],values[3]]);db.close();
});
const row=(observed,views)=>({publication_id:"p",content_item_id:"c",title:"Synthetic",platform:"douyin",external_url:null,published_at:"2026-09-01T00:00:00Z",observed_at:observed,views,likes:0,comments:0,shares:0,saves:0,followers_gained:0,leads:0,average_watch_seconds:null,completion_rate_bps:null});
test("mixed-offset historical snapshots choose the true latest and true pre-period baseline", () => {
  const result=buildAnalyticsSnapshot([row("2026-10-12T23:00:00Z",80),row("2026-10-13T09:00:00+08:00",100),row("2026-10-13T03:00:00Z",150)],"2026-10-13","2026-10-13");
  assert.equal(result.summary.views,70);assert.equal(result.topContent[0].cumulativeViews,150);
});
test("offset local date cannot incorrectly enter the UTC report period", () => {
  const result=buildAnalyticsSnapshot([row("2026-10-13T00:30:00+08:00",80)],"2026-10-13","2026-10-13");
  assert.equal(result.summary.contentCount,0);
});
test("historical equivalent instants use earliest saved data once and report conflicting metrics",()=>{
 const first={...row("2026-10-13T08:00:00+08:00",100),metric_id:"first",metric_created_at:"2026-10-14T00:00:00Z",published_at:"2026-10-13T00:00:00Z"};
 const second={...row("2026-10-13T00:00:00Z",999),metric_id:"second",metric_created_at:"2026-10-15T00:00:00Z",published_at:first.published_at};
 const values=[second,first],before=structuredClone(values),result=buildAnalyticsSnapshot(values,"2026-10-13","2026-10-13");
 assert.equal(result.summary.cumulativeViews,100);assert.equal(result.summary.timestampAliases,1);assert.equal(result.summary.timestampConflicts,1);assert.deepEqual(values,before);
});
