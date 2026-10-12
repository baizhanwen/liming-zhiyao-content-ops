import assert from 'node:assert/strict';
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
