CREATE TABLE IF NOT EXISTS `capability_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `analysis_profile` text NOT NULL,
  `content_model_profile` text NOT NULL,
  `keyframe_policy` text NOT NULL,
  `contract_version` text NOT NULL,
  `updated_at` text NOT NULL
);
INSERT OR IGNORE INTO `capability_policies` (`id`, `analysis_profile`, `content_model_profile`, `keyframe_policy`, `contract_version`, `updated_at`)
VALUES ('current', 'max', 'max', 'dense', 'analysis.v6', CURRENT_TIMESTAMP);
