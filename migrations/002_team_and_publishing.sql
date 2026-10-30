-- Team roles, client assignments, social account tokens, and the publishing workflow.
-- The Worker applies this automatically on first request (src/schema.js); it is kept here for reference.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'editor' WHERE role = 'member';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'editor', 'viewer'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'editor';
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('invited', 'active', 'disabled'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz;

CREATE TABLE IF NOT EXISTS client_members (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id)
);
CREATE INDEX IF NOT EXISTS client_members_user_idx ON client_members (user_id);

ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS access_token_enc text;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS refresh_token_enc text;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS scopes text NOT NULL DEFAULT '';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS avatar_url text NOT NULL DEFAULT '';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS profile_url text NOT NULL DEFAULT '';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS connected_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_status_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_status_check CHECK (status IN ('pending', 'connected', 'expired', 'error', 'disconnected'));

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform text NOT NULL,
  expires_at timestamptz NOT NULL
);

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE posts ADD CONSTRAINT posts_status_check CHECK (status IN (
  'draft', 'review', 'changes_requested', 'approved', 'scheduled', 'publishing', 'published', 'partial', 'failed'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE TABLE IF NOT EXISTS post_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'processing', 'published', 'failed')),
  provider_state jsonb NOT NULL DEFAULT '{}',
  external_post_id text NOT NULL DEFAULT '',
  external_url text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, social_account_id)
);
CREATE INDEX IF NOT EXISTS post_targets_status_idx ON post_targets (status);

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  object_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  post_id uuid REFERENCES posts(id) ON DELETE CASCADE,
  action text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_post_idx ON activity_log (post_id, created_at);
CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC);

INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
