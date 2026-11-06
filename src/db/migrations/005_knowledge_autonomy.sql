-- Stage 6: business knowledge (documents and website pages, chunked for search), AI drafting, Controlled Autonomous Mode.

-- A document you uploaded, text you pasted, or one page of your website. The extracted text is kept so it can
-- be re-chunked with different settings without uploading again.
CREATE TABLE knowledge_sources (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('file', 'text', 'web')),
  title         text NOT NULL,
  origin        text,                 -- file name, or the page URL
  site_root     text,                 -- web pages: the website link (Settings) the page was found from
  mime          text,
  raw_text      text NOT NULL DEFAULT '',
  content_hash  text,
  strategy      text NOT NULL CHECK (strategy IN ('structure', 'fixed')),
  chunk_words   integer NOT NULL CHECK (chunk_words BETWEEN 30 AND 1000),
  chunk_overlap integer NOT NULL CHECK (chunk_overlap >= 0),
  enabled       boolean NOT NULL DEFAULT true,
  word_count    integer NOT NULL DEFAULT 0,
  chunk_count   integer NOT NULL DEFAULT 0,
  fetched_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_sources_page_uq ON knowledge_sources (origin) WHERE kind = 'web';

-- Searchable pieces of a source. Full-text search always works; the embedding column (pgvector) is added at
-- start-up when the extension is enabled, because only a database superuser can enable it.
CREATE TABLE knowledge_chunks (
  id          bigserial PRIMARY KEY,
  source_id   bigint NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  ord         integer NOT NULL,
  heading     text,
  content     text NOT NULL,
  word_count  integer NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED,
  embedded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, ord)
);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);

-- Who approved a message: you, or the agent under Controlled Autonomous Mode.
ALTER TABLE messages ADD COLUMN approved_by text CHECK (approved_by IN ('user', 'agent'));
UPDATE messages SET approved_by = 'user' WHERE approved_at IS NOT NULL;
-- AI-written drafts are never approved by the agent, and record which knowledge they were given.
ALTER TABLE messages ADD COLUMN ai_generated boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN ai_sources jsonb;
