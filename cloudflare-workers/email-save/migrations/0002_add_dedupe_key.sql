ALTER TABLE emails ADD COLUMN dedupe_key TEXT;

UPDATE emails
SET dedupe_key = id
WHERE dedupe_key IS NULL;

CREATE UNIQUE INDEX emails_dedupe_key_unique_idx ON emails(dedupe_key);
