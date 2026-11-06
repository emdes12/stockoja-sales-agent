-- Stage 5: replies from your mailbox, reply drafts, booked demos.

-- Inbound messages (status 'received') and replies to them (step 'reply').
ALTER TABLE messages
  ADD COLUMN from_address        text,
  ADD COLUMN received_at         timestamptz,
  ADD COLUMN external_message_id text,          -- the email's Message-ID header; re-reading the mailbox never duplicates
  ADD COLUMN in_reply_to_id      bigint REFERENCES messages (id),
  ADD COLUMN classification      text CHECK (classification IN
    ('interested', 'demo_request', 'question', 'not_interested', 'opt_out', 'auto_reply', 'other')),
  ADD COLUMN classification_reasons jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN classified_by       text CHECK (classified_by IN ('agent', 'user')),
  ADD COLUMN needs_attention     boolean NOT NULL DEFAULT false,
  ADD COLUMN handled_at          timestamptz,
  ADD COLUMN source              text;          -- inbound: imap | manual

CREATE UNIQUE INDEX messages_inbound_external_uq ON messages (external_message_id)
  WHERE direction = 'inbound' AND external_message_id IS NOT NULL;
CREATE INDEX messages_attention_idx ON messages (received_at DESC) WHERE direction = 'inbound' AND needs_attention AND handled_at IS NULL;

-- A lead can get many replies, so 'reply' is exempt from one-per-step; instead, one live reply per inbound message.
DROP INDEX messages_one_live_step;
CREATE UNIQUE INDEX messages_one_live_step ON messages (lead_id, channel, step)
  WHERE direction = 'outbound' AND step <> 'reply' AND status NOT IN ('rejected', 'cancelled', 'failed');
CREATE UNIQUE INDEX messages_one_live_reply ON messages (in_reply_to_id)
  WHERE direction = 'outbound' AND status NOT IN ('rejected', 'cancelled', 'failed');

-- Mail that looks like a reply to our outreach but comes from an address we can't tie to a lead.
-- Only a short excerpt is kept, and it is cleared when you ignore the item.
CREATE TABLE inbox_unmatched (
  id                  bigserial PRIMARY KEY,
  external_message_id text NOT NULL UNIQUE,
  from_address        text,
  subject             text,
  excerpt             text,
  in_reply_to         text,
  received_at         timestamptz,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'linked', 'ignored')),
  linked_message_id   bigint REFERENCES messages (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Booked demos. The time comes from you or the booking notice; the agent never proposes one.
ALTER TABLE leads
  ADD COLUMN demo_at     timestamptz,
  ADD COLUMN demo_source text,                  -- user | booking_email
  ADD COLUMN demo_note   text;
