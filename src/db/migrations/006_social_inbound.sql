-- Stage 7, step 1: send-it-yourself social channels, the interest form, and referrals.

-- Instagram, Facebook, TikTok and Telegram messages are drafted by the agent and sent by you, like WhatsApp.
ALTER TABLE templates DROP CONSTRAINT templates_channel_check;
ALTER TABLE templates ADD CONSTRAINT templates_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram'));
ALTER TABLE messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram'));

-- A social account on the do-not-contact list, stored as "platform:username" (e.g. "instagram:adastyles").
ALTER TABLE suppressions DROP CONSTRAINT suppressions_kind_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_kind_check CHECK (kind IN ('email', 'phone', 'domain', 'handle'));

ALTER TABLE leads
  -- When they asked to hear from us through the interest form (with consent, if the form asks for it).
  ADD COLUMN asked_to_hear_at    timestamptz,
  -- The merchant who referred them, when the form answer or their personal link identifies one.
  ADD COLUMN referred_by_lead_id bigint REFERENCES leads (id),
  -- This merchant's own code, used in their personal form link. Created when first needed.
  ADD COLUMN referral_code       text UNIQUE;

CREATE INDEX leads_referred_by_idx ON leads (referred_by_lead_id) WHERE referred_by_lead_id IS NOT NULL;

-- Each answer read from the interest form's response sheet, so reading the sheet again never imports twice.
CREATE TABLE form_responses (
  id               bigserial PRIMARY KEY,
  row_key          text NOT NULL UNIQUE,   -- hash of the whole response row
  submitted_at     text,                   -- the form's own timestamp, as written in the sheet
  lead_id          bigint REFERENCES leads (id),
  outcome          text NOT NULL CHECK (outcome IN ('created', 'merged', 'seen', 'skipped')),
  skip_reason      text,
  referred_by_text text,
  referral_code    text,
  referrer_lead_id bigint REFERENCES leads (id),
  data             jsonb NOT NULL,         -- the answers, by the field they were mapped to
  imported_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_responses_lead_idx ON form_responses (lead_id);
