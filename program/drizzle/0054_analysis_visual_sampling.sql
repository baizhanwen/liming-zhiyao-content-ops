-- NULL preserves the historical sampler for existing jobs/checkpoints.
ALTER TABLE analysis_jobs ADD COLUMN visual_sampling_level TEXT DEFAULT NULL
  CHECK(visual_sampling_level IS NULL OR visual_sampling_level IN ('quick', 'balanced', 'detailed'));
