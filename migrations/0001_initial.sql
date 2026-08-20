PRAGMA foreign_keys = ON;

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'expired', 'revoked', 'error')),
  last_success_at TEXT,
  last_error_code TEXT
);
CREATE INDEX idx_connections_provider_status ON connections(provider, status);
CREATE INDEX idx_connections_valid_until ON connections(valid_until);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  identification_hash TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  lunch_money_account_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, identification_hash),
  UNIQUE(connection_id, provider_account_id)
);
CREATE INDEX idx_accounts_connection ON accounts(connection_id);
CREATE INDEX idx_accounts_identification_hash ON accounts(identification_hash);
CREATE INDEX idx_accounts_lunch_money_account ON accounts(lunch_money_account_id);

CREATE TABLE sync_index (
  external_id_hmac TEXT PRIMARY KEY,
  lunch_money_transaction_id INTEGER NOT NULL,
  payload_hmac TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sync_index_lunch_money_transaction ON sync_index(lunch_money_transaction_id);
CREATE INDEX idx_sync_index_last_seen ON sync_index(last_seen_at);

CREATE TABLE oauth_states (
  state_hmac TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'dry_run')),
  fetched_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);
CREATE INDEX idx_sync_runs_status ON sync_runs(status);

CREATE TABLE sync_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sync_locks_expires ON sync_locks(expires_at);
