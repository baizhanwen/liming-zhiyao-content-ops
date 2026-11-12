import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

test('card differentiates unanalysed, active, failed, cancelled and partial states',t=>{
  const {load}=runtimeFixture(t),{materialCardState:state}=load('lib/material-analysis-state.ts');
  const base={analysis_id:null,job_status:null,current_stage:null};
  assert.equal(state(base).label,'尚未分析');
  assert.equal(state({...base,job_status:'analyzing',current_stage:'结构分析'}).label,'结构分析');
  assert.equal(state({...base,job_status:'failed'}).label,'分析失败');
  assert.equal(state({...base,job_status:'cancelled'}).label,'已取消');
  assert.equal(state({...base,job_status:'partial'}).label,'报告待核对');
  assert.equal(state({...base,analysis_id:'report',job_status:'failed'}).label,'已有报告 · 最近分析失败');
});

test('historical imported v7 completed flag cannot conceal a failed quality audit',t=>{
  const {load}=runtimeFixture(t),{materialCardState:state}=load('lib/material-analysis-state.ts');
  assert.equal(state({analysis_id:'report',analysis_schema_version:'analysis.v7',analysis_quality_status:'degraded',analysis_acceptance_passed:0,analysis_completion_status:'partial',is_imported_job:1,job_status:'completed',current_stage:'imported'}).tone,'warning');
});

test('v12 completed report keeps pending manuscript amber without relabeling the report partial',t=>{
  const {load}=runtimeFixture(t),{materialCardState:state,materialAnalysisColumns}=load('lib/material-analysis-state.ts');
  const entry={analysis_id:'reviewed-report',analysis_schema_version:'analysis.v12',analysis_quality_status:'passed',analysis_acceptance_passed:1,analysis_completion_status:'complete',analysis_manuscript_status:'needs_review',analysis_review_segment_count:22,job_status:'completed',current_stage:'分析完成'};
  assert.deepEqual(state(entry),{label:'分析完成 · 22句口播待核对',tone:'warning',hint:'内容报告已完成；待核对口播保留原文，不作为已确认事实。'});
  assert.equal(state({...entry,job_status:'partial'}).label,'报告部分完成');
  assert.equal(state({...entry,analysis_manuscript_status:'verified',analysis_review_segment_count:0}).tone,'success');
  assert.equal(state({...entry,analysis_review_segment_count:null}).label,'分析完成 · 口播待核对');
  assert.match(materialAnalysisColumns,/unified_report.outcome.manuscript/);
  assert.match(materialAnalysisColumns,/unified_report.outcome.review_segment_count/);
});

test('v12 import preserves a safe completed report and explains pending manuscript coverage without rewriting its body',t=>{
  const {load}=runtimeFixture(t),{importedAnalysisState}=load('lib/material-analysis-state.ts');
  const report=readFileSync(new URL('./fixtures/unified-analysis-v12.json',import.meta.url),'utf8');
  const row={schema_version:'analysis.v12',report_json:report,created_at:'2026-01-01'};
  const state=importedAnalysisState([row],'2026-01-02');
  assert.equal(state.jobStatus,'completed');assert.equal(state.errorCode,null);
  assert.match(state.stage,/1句口播待核对/);assert.match(state.message,/1句口播待核对/);
  assert.equal(row.report_json,report);
});
