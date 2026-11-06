-- Read or not, like any inbox: separate from "needs attention" (which means "needs an answer").
-- Opening a conversation in the Inbox marks its messages read; you can mark one unread again.
ALTER TABLE messages ADD COLUMN read_at timestamptz;

-- Messages already dealt with count as read; the rest start unread.
UPDATE messages SET read_at = coalesce(handled_at, now())
WHERE direction = 'inbound' AND (handled_at IS NOT NULL OR NOT needs_attention);

CREATE INDEX messages_unread_idx ON messages (channel) WHERE direction = 'inbound' AND read_at IS NULL;

-- A message you write yourself from the Inbox (step 'message'): like replies, any number per person.
DROP INDEX messages_one_live_step;
CREATE UNIQUE INDEX messages_one_live_step ON messages (lead_id, channel, step)
  WHERE direction = 'outbound' AND step NOT IN ('reply', 'message') AND status NOT IN ('rejected', 'cancelled', 'failed');
