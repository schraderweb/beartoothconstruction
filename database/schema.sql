CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  overall_status TEXT NOT NULL DEFAULT 'stored',
  internal_email_status TEXT NOT NULL DEFAULT 'pending',
  internal_email_id TEXT,
  confirmation_email_status TEXT NOT NULL DEFAULT 'pending',
  confirmation_email_id TEXT,
  delivery_error TEXT
);

CREATE INDEX IF NOT EXISTS contact_submissions_created_at_idx
  ON contact_submissions (created_at);
