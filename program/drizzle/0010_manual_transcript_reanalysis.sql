ALTER TABLE `analysis_jobs` ADD `input_transcript_id` text REFERENCES `video_transcripts`(`id`);
--> statement-breakpoint
PRAGMA optimize;
