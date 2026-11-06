-- One inbox per channel, every message (not only replies from leads), replies from the app, and per-channel autonomy.

-- LinkedIn becomes a channel you send yourself (drafts, paste-in messages).
ALTER TABLE templates DROP CONSTRAINT templates_channel_check;
ALTER TABLE templates ADD CONSTRAINT templates_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'));
ALTER TABLE messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'));

-- Everyone who writes to you, on any channel, is a contact: an email address, a Meta id, a Telegram chat, or a
-- person whose message you pasted in. A contact may be tied to a lead; until then their messages have no lead.
ALTER TABLE social_contacts DROP CONSTRAINT social_contacts_platform_check;
ALTER TABLE social_contacts ADD CONSTRAINT social_contacts_platform_check
  CHECK (platform IN ('email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'));
-- You chose to ignore this person: their messages are kept out of "Needs attention" and get no drafts.
ALTER TABLE social_contacts ADD COLUMN ignored_at timestamptz;

-- A message belongs to a lead, or to a contact who isn't a lead (or both).
ALTER TABLE messages ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_party_check CHECK (lead_id IS NOT NULL OR social_contact_id IS NOT NULL);
-- The mailbox folder an email was read from.
ALTER TABLE messages ADD COLUMN folder text;
CREATE INDEX messages_contact_idx ON messages (social_contact_id, created_at);
CREATE INDEX messages_inbound_channel_idx ON messages (channel, received_at DESC) WHERE direction = 'inbound';

-- Waiting "not matched" items move into the inbox as messages from contacts.
INSERT INTO social_contacts (platform, external_id, last_inbound_at)
SELECT 'email', lower(from_address), max(received_at) FROM inbox_unmatched
WHERE status = 'open' AND channel = 'email' AND contact_id IS NULL AND from_address IS NOT NULL
GROUP BY lower(from_address)
ON CONFLICT (platform, external_id) DO NOTHING;

INSERT INTO messages (lead_id, channel, direction, subject, body, status, created_by, from_address, received_at, external_message_id,
  classification, classification_reasons, classified_by, needs_attention, source, social_contact_id)
SELECT NULL, u.channel, 'inbound', u.subject, coalesce(u.excerpt, '(no text)'), 'received', 'agent', u.from_address,
  coalesce(u.received_at, u.created_at), u.external_message_id, 'other', '[]', 'agent', true,
  CASE WHEN u.channel = 'email' THEN 'imap' ELSE 'meta' END,
  coalesce(u.contact_id, (SELECT c.id FROM social_contacts c WHERE c.platform = 'email' AND c.external_id = lower(u.from_address)))
FROM inbox_unmatched u
WHERE u.status = 'open' AND (u.contact_id IS NOT NULL OR u.from_address IS NOT NULL)
ON CONFLICT DO NOTHING;

UPDATE inbox_unmatched u SET status = 'linked', updated_at = now(),
  linked_message_id = (SELECT m.id FROM messages m WHERE m.external_message_id = u.external_message_id AND m.direction = 'inbound' LIMIT 1)
WHERE u.status = 'open';

-- "Auto-approve knowledge-base answers" becomes "Email: auto-send" in the per-channel reply settings.
INSERT INTO settings (key, value)
SELECT 'replyAutonomy', '{"email": "auto_send"}'::jsonb FROM settings WHERE key = 'autoApproveKbReplies' AND value = 'true'::jsonb
ON CONFLICT (key) DO NOTHING;
