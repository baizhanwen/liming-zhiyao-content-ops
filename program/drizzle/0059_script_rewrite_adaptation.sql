-- Older drafts and runs keep their original rewrite contract.
ALTER TABLE script_rewrite_runs ADD COLUMN adaptation_json TEXT;
ALTER TABLE script_rewrite_versions ADD COLUMN adaptation_json TEXT;
