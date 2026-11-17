-- The headline number: what share of drafts the gate blocked, per run and ruleset.
create or replace view p9_rejection_rate as
select d.run_id,
       g.ruleset_version,
       d.prompt_version_id,
       count(*)::int                                   as drafts,
       count(*) filter (where g.passed)::int           as passed,
       count(*) filter (where not g.passed)::int       as rejected,
       round(100.0 * count(*) filter (where not g.passed) / nullif(count(*), 0), 1) as rejection_rate_pct
from p9_gate_results g
join p9_drafts d on d.id = g.draft_id
group by d.run_id, g.ruleset_version, d.prompt_version_id;

-- Why drafts failed. This is the table the read-through groups by.
create or replace view p9_reject_reasons as
select d.run_id,
       g.ruleset_version,
       coalesce(g.reject_category, 'passed')           as reject_category,
       count(*)::int                                   as drafts,
       round(100.0 * count(*) / sum(count(*)) over (partition by d.run_id, g.ruleset_version), 1) as pct_of_run
from p9_gate_results g
join p9_drafts d on d.id = g.draft_id
group by d.run_id, g.ruleset_version, g.reject_category;

-- Where the deterministic rules and the model disagree.
--
-- On the 61-draft run this is the interesting one in both directions: the rules
-- flagged four drafts the model scored grounded 10/10 (all four were false
-- positives), and the model caught recruiting-misread drafts that passed every
-- rule.
create or replace view p9_rules_vs_model as
select d.run_id,
       g.ruleset_version,
       count(*) filter (where not (g.rule_length and g.rule_banned_phrases and g.rule_has_citation and g.rule_span_matches)
                          and g.evaluator_score >= 7)::int as rules_caught_model_missed,
       count(*) filter (where (g.rule_length and g.rule_banned_phrases and g.rule_has_citation and g.rule_span_matches)
                          and g.evaluator_score < 7)::int  as model_caught_rules_missed,
       count(*) filter (where not (g.rule_length and g.rule_banned_phrases and g.rule_has_citation and g.rule_span_matches)
                          and g.evaluator_score < 7)::int  as both_caught,
       count(*) filter (where g.evaluator_score is null)::int as no_model_score
from p9_gate_results g
join p9_drafts d on d.id = g.draft_id
group by d.run_id, g.ruleset_version;
