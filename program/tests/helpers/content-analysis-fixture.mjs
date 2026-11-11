import { readFileSync } from "node:fs";

export const contentTaxonomyFixture = JSON.parse(readFileSync(new URL("../../services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json", import.meta.url), "utf8"));
export function contentAnalysisFixture() {
  return {
    schema_version: "content-analysis.v1", taxonomy_version: contentTaxonomyFixture.version, profile: "standard", status: "complete",
    evidence_registry: [{ id: "transcript:0001", source: "transcript", text: "合成测试原文，只用于隔离验收。", start_ms: 0, end_ms: 1_000, asset_ref: null, frame_group_id: null }],
    classifications: contentTaxonomyFixture.dimensions.map(dimension => ({ dimension_id: dimension.id, state: "unknown", tags: null, primary_tag: null, reason: "合成样本未断言这个维度。", evidence_ids: [] })),
    segments: [], information_units: [],
    metrics: {
      version: "content-metrics.v1",
      media: { status: "measured", duration_ms: 1_000, duration_seconds: 1, duration_bucket: "under_15s", encoded_width: 1080, encoded_height: 1920, rotation_degrees: 0, sample_aspect_ratio: "1:1", display_aspect_ratio: "9:16", aspect_category: "9:16", aspect_status: "measured", aspect_reason: null },
      shot_detection: { status: "unknown", method: "ffmpeg_scene_score.v1", threshold: 0.3, boundaries_ms: [], segments: [], detected_cut_count: null, detected_shot_count: null, mean_shot_seconds: null, cuts_per_minute: null, limitations: ["合成样本未测量剪辑。"] },
      transcript_statistics: { status: "estimated", source: "uncorrected_transcript_after_overlap_dedup", character_count: 10, character_count_method: "unicode_letters_numbers.v1", characters_per_video_second: 10, segments: [{ source_segment_id: "transcript:0001", start_ms: 0, end_ms: 1_000, character_count: 10, characters_per_second: 10, status: "estimated" }], limitations: ["不是声学速度。"] },
      methodology: { version: "content-metrics.v1", time_unit: "milliseconds", aspect_category_relative_tolerance: 0.01, character_count_method: "unicode_letters_numbers.v1", audio_analysis: "out_of_scope", profile_invariant: true },
    },
    methodology: { transcript_source: "asr", sampling_strategy_id: "synthetic-sampling.v1", sampling_config: { interval_seconds: 1 }, evidence_version: "content-evidence.v1", temporal_min_frames: 3 },
    module_status: Object.fromEntries(contentTaxonomyFixture.modules.map(module => [module, { status: "completed", reason: null, validation: { passed: true, issues: [] } }])),
    validation: { passed: true, issues: [] },
  };
}
export function setKnown(content, dimensionId, tags, primary = null, evidenceIds = ["transcript:0001"]) {
  const row = content.classifications.find(classification => classification.dimension_id === dimensionId);
  Object.assign(row, { state: "known", tags, primary_tag: primary, reason: null, evidence_ids: evidenceIds });
  return content;
}
export const analysisReportFixture = content => ({ summary: "隔离测试报告", analysis_meta: { contract_version: "analysis.v10", quality_audit: { status: "passed", acceptance_passed: true, completion_status: "complete", issues: [] } }, content_analysis: content ?? contentAnalysisFixture() });
