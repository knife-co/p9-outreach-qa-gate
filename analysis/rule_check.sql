-- Reproduces the headline measurement: the deterministic rejection rate under
-- both rulesets, over every draft in a run.
--
-- No model is called and no API quota is used, which is the point - this number
-- is reproducible by anyone with the data, and does not depend on which judge
-- model was available on the day.
--
-- On run dbf4a8cd (61 drafts, 16 Nov 2026) it returns:
--
--   fail_length               0
--   fail_no_citation          1
--   fail_ungrounded_quote     4   <- all four hand-checked, all four false positives
--   fail_banned_ruleset1      0   <- 31 cliches, zero hits
--   fail_banned_ruleset2     41
--   reject_pct_ruleset1     6.6
--   reject_pct_ruleset2    68.9
--
-- Thirteen phrases added to a list, and the rate moves 62 points on identical drafts.

\set run_id 'PUT-YOUR-RUN-ID-HERE'

with norm as (
  select d.id, d.company_key, d.citations, d.model_error,
         regexp_replace(lower(replace(replace(replace(replace(replace(replace(
           d.body,'’',''''),'‘',''''),'“','"'),'”','"'),'–','-'),'—','-')),'\s+',' ','g') as nbody,
         array_length(string_to_array(trim(regexp_replace(d.body,'\s+',' ','g')),' '),1) as words
  from p9_drafts d
  where d.run_id = :'run_id'
),
b1(p) as (values ('hope this finds you well'),('hope you are well'),('i came across'),('came across your'),
  ('reaching out'),('reached out'),('touch base'),('circle back'),('quick question'),('just wanted to'),
  ('i wanted to reach'),('excited to'),('thrilled to'),('revolutioniz'),('revolutionis'),('game-chang'),
  ('game chang'),('synergy'),('synergies'),('cutting-edge'),('best-in-class'),('world-class'),('seamless'),
  ('needle-moving'),('move the needle'),('low-hanging fruit'),('in today''s fast'),('as you may know'),
  ('i hope'),('let me know if'),('does that resonate')),
b2extra(p) as (values ('i saw you are hiring'),('i saw you were hiring'),('i saw that you'),
  ('i noticed you are'),('i noticed that you'),('i noticed your'),
  ('you are currently hiring'),('i see you are hiring'),
  ('i see that you'),('we can help you'),('i can help you build')),
spans as (
  select n.id,
         count(*) filter (where c->>'quote' is null or btrim(c->>'quote') = '' or c->>'evidence_id' is null) as bad_cite,
         count(*) as cites,
         count(*) filter (where not exists (
           select 1 from p9_evidence e
           where e.id = (c->>'evidence_id')::bigint
             and e.company_key = n.company_key
             and e.run_id = :'run_id'
             and regexp_replace(lower(replace(replace(replace(replace(replace(replace(
                   e.raw_excerpt,'’',''''),'‘',''''),'“','"'),'”','"'),'–','-'),'—','-')),'\s+',' ','g')
                 like '%' || regexp_replace(lower(replace(replace(replace(replace(replace(replace(
                   c->>'quote','’',''''),'‘',''''),'“','"'),'”','"'),'–','-'),'—','-')),'\s+',' ','g') || '%'
         )) as unmatched
  from norm n, lateral jsonb_array_elements(coalesce(n.citations,'[]'::jsonb)) c
  group by n.id
),
scored as (
  select n.id, n.company_key, n.words,
         (n.model_error is null and n.words between 12 and 60)                       as rule_length,
         not exists (select 1 from b1 where n.nbody like '%'||b1.p||'%')             as rule_banned_v1,
         not exists (select 1 from b1 where n.nbody like '%'||b1.p||'%')
           and not exists (select 1 from b2extra where n.nbody like '%'||b2extra.p||'%') as rule_banned_v2,
         coalesce(s.cites,0) > 0 and coalesce(s.bad_cite,0) = 0                      as rule_has_citation,
         coalesce(s.cites,0) > 0 and coalesce(s.bad_cite,0) = 0
           and coalesce(s.unmatched,0) = 0                                           as rule_span
  from norm n left join spans s on s.id = n.id
)
select count(*) as drafts,
       count(*) filter (where not rule_length)        as fail_length,
       count(*) filter (where not rule_has_citation)  as fail_no_citation,
       count(*) filter (where not rule_span)          as fail_ungrounded_quote,
       count(*) filter (where not rule_banned_v1)     as fail_banned_ruleset1,
       count(*) filter (where not rule_banned_v2)     as fail_banned_ruleset2,
       round(100.0*count(*) filter (where not (rule_length and rule_has_citation and rule_span and rule_banned_v1))/count(*),1) as reject_pct_ruleset1,
       round(100.0*count(*) filter (where not (rule_length and rule_has_citation and rule_span and rule_banned_v2))/count(*),1) as reject_pct_ruleset2
from scored;
