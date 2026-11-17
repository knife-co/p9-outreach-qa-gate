-- P9: AI outreach with a QA gate.
-- Principle: deterministic rails, probabilistic decisions inside them.

create table if not exists p9_prompts (
  id            bigserial primary key,
  name          text not null check (name in ('research','draft','evaluate')),
  version       int  not null,
  body          text not null,
  model         text not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (name, version)
);

create table if not exists p9_runs (
  run_id        uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  company_count int,
  notes         text
);

-- claim = the model's or collector's wording.
-- raw_excerpt = the exact source text it came from.
--
-- The grounding check matches against raw_excerpt, NEVER against claim, so a
-- drafting model is never checked against another model's paraphrase. The raw
-- excerpt is the only thing in the chain that no model wrote.
create table if not exists p9_evidence (
  id            bigserial primary key,
  run_id        uuid not null references p9_runs(run_id) on delete cascade,
  company_key   text not null,
  source_type   text not null check (source_type in ('job_posting','homepage','news','signal_record','other')),
  source_url    text,
  field         text,
  claim         text not null,
  raw_excerpt   text not null,
  retrieved_at  timestamptz not null default now()
);

create table if not exists p9_drafts (
  id                bigserial primary key,
  run_id            uuid not null references p9_runs(run_id) on delete cascade,
  company_key       text not null,
  prompt_version_id bigint not null references p9_prompts(id),
  body              text not null,
  citations         jsonb not null default '[]'::jsonb,
  model_error       text,
  created_at        timestamptz not null default now()
);

-- Separate from the draft on purpose: rulesets change, and re-scoring old drafts
-- must not destroy what the previous ruleset decided. This table is the reason
-- the 6.6% -> 68.9% comparison was possible at all.
create table if not exists p9_gate_results (
  id                  bigserial primary key,
  draft_id            bigint not null references p9_drafts(id) on delete cascade,
  ruleset_version     int not null default 1,
  rule_length         boolean,
  rule_banned_phrases boolean,
  banned_hits         text[],
  rule_has_citation   boolean,
  rule_span_matches   boolean,
  unmatched_spans     jsonb,
  evaluator_score     numeric,
  evaluator_reasons   jsonb,
  passed              boolean,
  route               text check (route in ('send_queue','human_review')),
  reject_category     text,
  checked_at          timestamptz not null default now(),
  unique (draft_id, ruleset_version)
);

create index if not exists p9_evidence_company on p9_evidence (company_key, run_id);
create index if not exists p9_drafts_run on p9_drafts (run_id);
create index if not exists p9_gate_draft on p9_gate_results (draft_id, ruleset_version);

alter table p9_prompts        enable row level security;
alter table p9_runs           enable row level security;
alter table p9_evidence       enable row level security;
alter table p9_drafts         enable row level security;
alter table p9_gate_results   enable row level security;
