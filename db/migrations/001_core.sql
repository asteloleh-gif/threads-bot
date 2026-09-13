CREATE TABLE IF NOT EXISTS brands (
  brand_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_accounts (
  account_key TEXT PRIMARY KEY,
  brand_key TEXT NOT NULL REFERENCES brands(brand_key) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  platform_user_id TEXT,
  language TEXT NOT NULL DEFAULT 'auto',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS social_accounts_brand_idx ON social_accounts(brand_key);
CREATE INDEX IF NOT EXISTS social_accounts_platform_idx ON social_accounts(platform);

CREATE TABLE IF NOT EXISTS posts (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  platform_post_id TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  permalink TEXT,
  published_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_account_platform_id_uq
  ON posts(account_key, platform_post_id)
  WHERE platform_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_account_published_idx ON posts(account_key, published_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  content JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  source TEXT,
  scheduled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drafts_account_status_idx ON drafts(account_key, status);
CREATE INDEX IF NOT EXISTS drafts_scheduled_idx ON drafts(scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS publish_runs (
  job_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  draft_id TEXT REFERENCES drafts(draft_id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  platform_post_id TEXT,
  error_code TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS publish_runs_account_status_idx ON publish_runs(account_key, status);
CREATE INDEX IF NOT EXISTS publish_runs_scheduled_idx ON publish_runs(scheduled_at);

CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  root_id TEXT,
  parent_id TEXT,
  author_id TEXT,
  author_username TEXT,
  text TEXT NOT NULL DEFAULT '',
  surface TEXT,
  occurred_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_key, source_id)
);
CREATE INDEX IF NOT EXISTS comments_account_root_idx ON comments(account_key, root_id);
CREATE INDEX IF NOT EXISTS comments_account_parent_idx ON comments(account_key, parent_id);
CREATE INDEX IF NOT EXISTS comments_occurred_idx ON comments(occurred_at DESC);

CREATE TABLE IF NOT EXISTS replies (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  source_comment_id TEXT NOT NULL,
  platform_reply_id TEXT,
  status TEXT NOT NULL,
  text TEXT,
  published_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS replies_account_platform_id_uq
  ON replies(account_key, platform_reply_id)
  WHERE platform_reply_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS replies_source_comment_idx ON replies(account_key, source_comment_id);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metrics JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS analytics_entity_time_idx
  ON analytics_snapshots(account_key, entity_type, entity_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS content_briefs (
  brief_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  brief JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS content_briefs_account_status_idx ON content_briefs(account_key, status);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  account_key TEXT REFERENCES social_accounts(account_key) ON DELETE SET NULL,
  workflow_id TEXT,
  node TEXT,
  model TEXT,
  status TEXT NOT NULL,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cached_input_tokens BIGINT,
  cost_microusd BIGINT,
  latency_ms BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_runs_account_time_idx ON agent_runs(account_key, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_workflow_idx ON agent_runs(workflow_id);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  hypothesis TEXT,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS experiments_account_status_idx ON experiments(account_key, status);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL REFERENCES social_accounts(account_key) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reviewer TEXT,
  source TEXT,
  decision_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approvals_account_status_idx ON approvals(account_key, status);
CREATE INDEX IF NOT EXISTS approvals_subject_idx ON approvals(subject_type, subject_id);
