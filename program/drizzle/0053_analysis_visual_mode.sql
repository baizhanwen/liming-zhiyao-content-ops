-- Preserve the existing OCR + visual model path for historical jobs.
ALTER TABLE analysis_jobs ADD COLUMN visual_analysis_mode TEXT NOT NULL DEFAULT 'hybrid'
  CHECK(visual_analysis_mode IN ('hybrid', 'vision_only'));
