type MediaJobFailure = { error_code?: string | null; error_message?: string | null };

/** Keep stored diagnostics intact while giving media failures a readable summary. */
export function mediaErrorPresentation(job: MediaJobFailure): { message: string; guidance: string } | null {
  const diagnostic = job.error_message || "";
  const legacyJpegFailure = job.error_code === "WORKER_PROCESSING_FAILED"
    && /\[mjpeg\s*@/i.test(diagnostic)
    && /ff_frame_thread_encoder_init failed|Non full-range YUV|Nothing was written into output file/i.test(diagnostic);
  if (job.error_code === "VISUAL_EXTRACTION_FAILED" || legacyJpegFailure) {
    return {
      message: "视频画面提取失败，未能取得可用图片。",
      guidance: "请重试当前任务；若仍失败，请联系管理员检查分析主机的抽帧日志。",
    };
  }
  if (job.error_code === "MEDIA_PROCESSING_FAILED") {
    return {
      message: "视频或音频处理失败，未能完成媒体读取。",
      guidance: "请检查原文件能否正常播放；若仍失败，请联系管理员检查媒体处理日志。",
    };
  }
  return null;
}
