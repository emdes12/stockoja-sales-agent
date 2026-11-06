-- Stage 4: email sending (dry-run or live), delivery tracking, follow-ups.

-- dry_run: rendered and logged exactly as it would be sent, but not sent. Terminal; can be re-queued in live mode.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('draft', 'approved', 'rejected', 'cancelled', 'sending', 'sent', 'failed', 'received', 'dry_run'));

ALTER TABLE messages
  ADD COLUMN send_started_at     timestamptz,  -- first hand-off to Resend; with the idempotency key, a retry within 24h cannot send twice
  ADD COLUMN dry_run_at          timestamptz,
  ADD COLUMN delivery_status     text,         -- Resend last_event: delivered, bounced, complained, opened…
  ADD COLUMN delivery_checked_at timestamptz;

CREATE INDEX messages_sent_at_idx ON messages (sent_at) WHERE sent_by = 'provider';
