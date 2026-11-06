-- Stage 3: knowledge base, message templates, approval queue, do-not-contact list.

-- Pipeline statuses after qualification. Scoring only ever moves discovered/qualified/unqualified.
ALTER TABLE leads DROP CONSTRAINT leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (status IN (
  'discovered', 'qualified', 'unqualified', 'archived', 'do_not_contact',
  'contacted', 'replied', 'interested', 'demo_booked', 'registered', 'activated', 'declined'
));

-- Product answers the agent may use. Only "approved" entries are ever used.
CREATE TABLE kb_entries (
  id          bigserial PRIMARY KEY,
  topic       text NOT NULL,
  question    text NOT NULL,
  answer      text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  source      text,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  step       text NOT NULL CHECK (step IN ('intro', 'followup_1', 'followup_2')),
  category   text,                 -- null = any category
  subject    text,                 -- email only
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every message drafted, approved, sent or received. Never deleted: rejected/cancelled stay as history.
CREATE TABLE messages (
  id                  bigserial PRIMARY KEY,
  lead_id             bigint NOT NULL REFERENCES leads (id),
  channel             text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  direction           text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  step                text,
  template_id         bigint REFERENCES templates (id),
  to_address          text,
  subject             text,
  body                text NOT NULL,
  original_body       text,          -- what the agent drafted, kept when you edit
  status              text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'cancelled', 'sending', 'sent', 'failed', 'received')),
  created_by          text NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent', 'user')),
  edited              boolean NOT NULL DEFAULT false,
  status_reason       text,
  approved_at         timestamptz,
  sent_at             timestamptz,
  sent_by             text CHECK (sent_by IN ('provider', 'user')),
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_lead_idx ON messages (lead_id, created_at);
CREATE INDEX messages_status_idx ON messages (status, created_at DESC);
-- One live outbound message per lead, channel and step: drafting twice (or after a restart) cannot duplicate.
CREATE UNIQUE INDEX messages_one_live_step ON messages (lead_id, channel, step)
  WHERE direction = 'outbound' AND status NOT IN ('rejected', 'cancelled', 'failed');

-- Addresses that must never be contacted. Lifting keeps the row (lifted_at) as history.
CREATE TABLE suppressions (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('email', 'phone', 'domain')),
  value      text NOT NULL,
  reason     text,
  source     text NOT NULL DEFAULT 'user',   -- user | do_not_contact | reply_stop | bounce
  lead_id    bigint REFERENCES leads (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  lift_reason text
);
CREATE UNIQUE INDEX suppressions_active_uq ON suppressions (kind, value) WHERE lifted_at IS NULL;
