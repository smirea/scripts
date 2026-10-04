ALTER TABLE emails ADD COLUMN inbox TEXT NOT NULL DEFAULT 'email-save'
  CHECK (inbox IN ('email-save', 'spam'));

CREATE INDEX emails_inbox_received_at_idx ON emails(inbox, received_at DESC);
CREATE INDEX emails_inbox_thread_idx ON emails(inbox, thread_key, received_at DESC);
