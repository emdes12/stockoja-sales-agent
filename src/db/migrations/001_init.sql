-- Stage 1–2: settings, logs, task queue, cost tracking, leads and discovery.

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE logs (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  scope   text NOT NULL,
  message text NOT NULL,
  data    jsonb
);
CREATE INDEX logs_at_idx ON logs (at DESC);
CREATE INDEX logs_level_idx ON logs (level, at DESC);

CREATE TABLE leads (
  id               bigserial PRIMARY KEY,
  business_name    text NOT NULL,
  name_key         text NOT NULL,          -- normalised name used for de-duplication
  category         text NOT NULL,
  source_tag       text,                   -- e.g. OSM shop=clothes
  city             text,
  state            text,
  address          text,
  lat              double precision,
  lon              double precision,
  phone            text,
  phone_key        text,                   -- 234XXXXXXXXXX
  email            text,
  website          text,
  website_domain   text,
  socials          jsonb NOT NULL DEFAULT '{}',
  branch_count     integer NOT NULL DEFAULT 1,
  is_chain_brand   boolean NOT NULL DEFAULT false,
  source           text NOT NULL,          -- first source: osm | csv | manual
  source_url       text,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  score            integer,
  score_breakdown  jsonb NOT NULL DEFAULT '[]',
  facts            jsonb NOT NULL DEFAULT '[]',  -- verified, each with its source
  assumptions      jsonb NOT NULL DEFAULT '[]',  -- inferred, each with its reasoning
  relevance        jsonb NOT NULL DEFAULT '[]',  -- which StockỌja features fit, and why
  status           text NOT NULL DEFAULT 'discovered'
                   CHECK (status IN ('discovered', 'qualified', 'unqualified', 'archived', 'do_not_contact')),
  status_set_by    text NOT NULL DEFAULT 'auto' CHECK (status_set_by IN ('auto', 'user')),
  notes            text,
  qualified_at     timestamptz,
  enriched_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_name_key_idx ON leads (name_key, state);
CREATE INDEX leads_phone_key_idx ON leads (phone_key) WHERE phone_key IS NOT NULL;
CREATE INDEX leads_domain_idx ON leads (website_domain) WHERE website_domain IS NOT NULL;
CREATE INDEX leads_email_idx ON leads (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX leads_status_idx ON leads (status, score DESC);
CREATE INDEX leads_category_idx ON leads (category);

-- Every sighting of a lead in a source. (source, source_ref) is unique, so re-running discovery never duplicates.
CREATE TABLE lead_sources (
  id          bigserial PRIMARY KEY,
  lead_id     bigint NOT NULL REFERENCES leads (id),
  source      text NOT NULL,
  source_ref  text NOT NULL,
  source_url  text,
  data        jsonb NOT NULL DEFAULT '{}',
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_ref)
);
CREATE INDEX lead_sources_lead_idx ON lead_sources (lead_id);

CREATE TABLE discovery_runs (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  params      jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  found       integer NOT NULL DEFAULT 0,
  created     integer NOT NULL DEFAULT 0,
  merged      integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  error       text,
  task_id     bigint,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Persistent task queue. Only the running app executes tasks; nothing runs while it is closed.
CREATE TABLE tasks (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled', 'needs_review')),
  idempotency_key text UNIQUE,
  run_at          timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  review_reason   text,
  result          jsonb,
  lead_id         bigint REFERENCES leads (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX tasks_due_idx ON tasks (run_at, id) WHERE status = 'pending';
CREATE INDEX tasks_status_idx ON tasks (status, updated_at DESC);
CREATE INDEX tasks_lead_idx ON tasks (lead_id) WHERE lead_id IS NOT NULL;

-- External calls and their estimated cost. Free sources are recorded too (cost 0) so usage is visible.
CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  provider      text NOT NULL,
  kind          text NOT NULL,
  units         integer NOT NULL DEFAULT 1,
  estimated_usd numeric(12, 6) NOT NULL DEFAULT 0,
  detail        jsonb
);
CREATE INDEX usage_events_at_idx ON usage_events (at DESC);
