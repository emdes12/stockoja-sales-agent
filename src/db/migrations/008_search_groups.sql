-- Step 3 of the channels proposal: web search (Tavily / Brave) and WhatsApp group exports (assist only).

-- Each web search you run, with what came back. Repeating the same search within a few days reuses it (no spend).
CREATE TABLE web_searches (
  id          bigserial PRIMARY KEY,
  provider    text NOT NULL CHECK (provider IN ('tavily', 'brave')),
  query       text NOT NULL,
  scope       text NOT NULL DEFAULT 'any',
  results     jsonb NOT NULL DEFAULT '[]',
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_searches_lookup_idx ON web_searches (provider, lower(query), scope, created_at DESC);

-- Leads found in a WhatsApp group you exported. They never agreed to be contacted, so they are low-trust:
-- only messages you send yourself, an opt-out in the first line, and STOP respected strictly.
ALTER TABLE leads ADD COLUMN group_source text;
