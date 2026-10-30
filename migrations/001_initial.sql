CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_tokens_expires_at_idx ON login_tokens (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key text PRIMARY KEY,
  last_requested_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  industry text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clients_name_idx ON clients (lower(name));

CREATE TABLE IF NOT EXISTS social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'threads')),
  external_account_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  token_secret_ref text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'expired', 'error')),
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_account_id)
);
CREATE INDEX IF NOT EXISTS social_accounts_client_idx ON social_accounts (client_id, status);

CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content text NOT NULL DEFAULT '',
  platforms text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'scheduled', 'published', 'failed')),
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_planner_idx ON posts (scheduled_at, status);
CREATE INDEX IF NOT EXISTS posts_client_idx ON posts (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks (status, due_on);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'threads')),
  metric_date date NOT NULL,
  reach bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  engagements bigint NOT NULL DEFAULT 0 CHECK (engagements >= 0),
  followers_gained integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, platform, metric_date)
);
CREATE INDEX IF NOT EXISTS analytics_daily_date_idx ON analytics_daily (metric_date DESC);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  social_account_id uuid REFERENCES social_accounts(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'threads')),
  external_message_id text NOT NULL,
  sender_name text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_message_id)
);
CREATE INDEX IF NOT EXISTS inbox_messages_received_idx ON inbox_messages (received_at DESC);
