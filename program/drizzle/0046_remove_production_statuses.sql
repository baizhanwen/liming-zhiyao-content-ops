-- Retired manual production markers have already passed review.
-- Preserve content, versions, review history and timestamps while moving them
-- to the next supported workflow state (including soft-deleted content).
UPDATE content_items
SET status = 'publish_ready'
WHERE status IN ('shooting_ready', 'shot', 'editing');
