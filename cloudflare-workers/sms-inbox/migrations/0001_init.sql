CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	received_at TEXT NOT NULL,
	sender TEXT NOT NULL,
	text TEXT NOT NULL,
	thread_key TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX messages_received_at_idx ON messages(received_at DESC);
CREATE INDEX messages_thread_idx ON messages(thread_key, received_at DESC);
CREATE INDEX messages_sender_idx ON messages(sender);
