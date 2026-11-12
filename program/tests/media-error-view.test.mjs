import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

test('media error presentation summarizes typed failures without changing stored diagnostics', t => {
  const {load}=runtimeFixture(t),{mediaErrorPresentation}=load('lib/media-error-view.ts');
  const diagnostic='[mjpeg @ 0x0] Non full-range YUV is non-standard. ff_frame_thread_encoder_init failed. Nothing was written into output file.';
  const job={error_code:'VISUAL_EXTRACTION_FAILED',error_message:diagnostic};
  const view=mediaErrorPresentation(job);
  assert.equal(view.message,'视频画面提取失败，未能取得可用图片。');
  assert.match(view.guidance,/抽帧日志/);
  assert.equal(job.error_message,diagnostic);
  assert.doesNotMatch(view.message,/mjpeg|YUV|0x0/);
  assert.match(mediaErrorPresentation({...job,error_code:'MEDIA_PROCESSING_FAILED'}).message,/媒体读取/);
});

test('legacy generic JPEG failure is readable while unrelated failures remain untouched', t => {
  const {load}=runtimeFixture(t),{mediaErrorPresentation}=load('lib/media-error-view.ts');
  const job={error_code:'WORKER_PROCESSING_FAILED',error_message:'[mjpeg @ 0x0] Non full-range YUV is non-standard. ff_frame_thread_encoder_init failed'};
  assert.match(mediaErrorPresentation(job).message,/画面提取失败/);
  for(const unrelated of [
    {...job,error_code:'MODEL_REQUEST_FAILED'},
    {...job,error_message:'worker connection failed'},
    {...job,error_message:'Non full-range YUV mentioned in a model response'},
  ]) assert.equal(mediaErrorPresentation(unrelated),null);
});
