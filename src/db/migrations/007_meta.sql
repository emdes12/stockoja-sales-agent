-- Step 2 of the channels proposal: the Meta app (Instagram profile lookup, Instagram/Facebook inbox replies).

-- What Instagram's Business Discovery returned for a lead's profile, and when.
ALTER TABLE leads
  ADD COLUMN instagram_profile    jsonb,
  ADD COLUMN instagram_checked_at timestamptz;

-- People who messaged your Facebook Page or Instagram account. external_id is the page-scoped id Meta gives each
-- person (PSID / IGSID); it is what a reply is addressed to. last_inbound_at decides Meta's 24-hour reply window.
CREATE TABLE social_contacts (
  id              bigserial PRIMARY KEY,
  platform        text NOT NULL CHECK (platform IN ('instagram', 'facebook')),
  external_id     text NOT NULL,
  username        text,
  name            text,
  lead_id         bigint REFERENCES leads (id),
  thread_id       text,
  last_inbound_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE INDEX social_contacts_lead_idx ON social_contacts (lead_id);

-- An inbound Instagram/Facebook message (and the reply to it) knows who it came from.
ALTER TABLE messages ADD COLUMN social_contact_id bigint REFERENCES social_contacts (id);

-- Unmatched messages can now come from Instagram and Facebook as well as email.
ALTER TABLE inbox_unmatched
  ADD COLUMN channel    text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'instagram', 'facebook')),
  ADD COLUMN contact_id bigint REFERENCES social_contacts (id);
