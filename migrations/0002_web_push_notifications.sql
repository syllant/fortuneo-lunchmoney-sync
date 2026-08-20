CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT
);
CREATE INDEX idx_push_subscriptions_updated ON push_subscriptions(updated_at DESC);

CREATE TABLE notification_events (
  event_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX idx_notification_events_sent ON notification_events(sent_at DESC);
