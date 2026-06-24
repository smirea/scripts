CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  normalized_subject TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  thread_key TEXT NOT NULL,
  thread_basis TEXT NOT NULL,
  forwarded_from TEXT,
  forwarded_to TEXT,
  forwarded_date TEXT,
  forwarded_subject TEXT,
  raw_key TEXT NOT NULL,
  headers_key TEXT NOT NULL,
  text_key TEXT,
  html_key TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  raw_size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX emails_received_at_idx ON emails(received_at DESC);
CREATE INDEX emails_thread_idx ON emails(thread_key, received_at DESC);
CREATE INDEX emails_from_idx ON emails(from_addr);
CREATE INDEX emails_normalized_subject_idx ON emails(normalized_subject);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  attachment_index INTEGER NOT NULL,
  filename TEXT,
  mime_type TEXT,
  content_id TEXT,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX attachments_email_idx ON attachments(email_id, attachment_index);
