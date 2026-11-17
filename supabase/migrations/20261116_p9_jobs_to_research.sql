-- Research targets are OPEN job postings, not companies.
--
-- A buying signal points at a job posting, and job postings disappear - often
-- within a week or two. The signal row keeps a snapshot from the day it fired,
-- but the posting it describes may be long gone, so fetching its body returns 404.
-- That is exactly what happened on the first run: the signal fired 12 October and
-- the posting closed on 17 October.
--
-- ats_jobs is refreshed daily by the collector and carries closed_at, so it is the
-- only trustworthy source for "is there still something here to read".
--
-- This also exists because PostgREST serves only the `public` schema. The
-- warehouse tables live in `analytics`; exposing that schema to the API so one
-- Edge Function could read five columns would have opened seventeen tables to the
-- internet. The selection happens in the database instead.
--
-- gate_passed is returned so later analysis can split on it without re-joining.
create or replace function p9_jobs_to_research(
  p_limit          int      default 1,
  p_keys           text[]   default null,
  p_good_fit_only  boolean  default false
)
returns table (
  company_key   text,
  company_name  text,
  domain        text,
  gate_passed   boolean,
  ats           text,
  token         text,
  job_id        text,
  job_title     text,
  job_url       text,
  job_function  text,
  seniority     text,
  location      text,
  last_seen_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- distinct-on dedupes the job, the outer query decides the order they come back in.
  select q.company_key, q.company_name, q.domain, q.gate_passed,
         q.ats, q.token, q.job_id, q.job_title, q.job_url,
         q.job_function, q.seniority, q.location, q.last_seen_at
  from (
    select distinct on (j.ats, j.token, j.job_id)
           c.company_key, c.company_name, c.domain, c.gate_passed,
           j.ats, j.token, j.job_id,
           j.title as job_title, j.url as job_url,
           j.job_function, j.seniority, j.location, j.last_seen_at
    from signals s
    join ats_jobs j
      on j.ats    = split_part(s.ref, ':', 1)
     and j.token  = split_part(s.ref, ':', 2)
     and j.job_id = split_part(s.ref, ':', 3)
    join icp_companies c
      on c.company_key = s.company_key
    where s.signal_type = 'gtm_hire'
      and s.ref is not null
      and s.company_key is not null
      and j.closed_at is null
      and (p_keys is null or c.company_key = any (p_keys))
      and (not coalesce(p_good_fit_only, false) or c.gate_passed)
    order by j.ats, j.token, j.job_id, j.last_seen_at desc
  ) q
  order by q.gate_passed desc, q.last_seen_at desc, q.company_key
  limit greatest(coalesce(p_limit, 1), 1)
$$;
