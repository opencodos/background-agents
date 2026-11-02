-- Fork-only (#1370 supersession): mark the review sessions that existed before 0101, so a review
-- in flight across the deploy can still mint the reviewer App's token. A fenced GitHub bot
-- session is a review session: the bot fences only review requests and auto-reviews. Sessions
-- the previous worker creates after this runs are covered by the review-token route, which also
-- accepts a session whose fence currently holds its PR's submission lease.
UPDATE sessions SET github_review = 1
WHERE spawn_source = 'github-bot'
  AND id IN (SELECT session_id FROM github_review_sessions);
