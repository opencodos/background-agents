CREATE TABLE github_review_publications (
  publication_key TEXT PRIMARY KEY,
  provider_review_id TEXT UNIQUE,
  repository_external_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('findings', 'no_findings')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'uncertain')),
  marker TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_session_id, source_message_id)
);

CREATE INDEX idx_github_review_publications_provider_review
  ON github_review_publications(provider_review_id);
