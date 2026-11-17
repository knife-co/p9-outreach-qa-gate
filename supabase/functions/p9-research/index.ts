// P9 step 1: the researcher.
//
// Gathers real, checkable evidence about a company before anything writes a word.
// No language model runs here on purpose - this step only moves facts around, and
// a step that only moves facts should be deterministic.
//
// Targets are OPEN job postings, from p9_jobs_to_research. The first version
// selected by company and fetched the posting named on the signal; that returned
// 404, because the signal was a month old and the posting had closed five days
// after it fired. Signals keep a snapshot, ats_jobs keeps the truth.
//
// Evidence per company:
//   1. Structured fields for EVERY open GTM role at that company - title, function,
//      seniority, location. Several roles open at once is itself the strongest fact
//      available, so none of them are thrown away.
//   2. The full description body for the first few roles only, to bound prompt size.
//
// Every row carries `claim` (readable) and `raw_excerpt` (exact source text). The
// gate matches citations against raw_excerpt only, so a drafting model is never
// checked against another model's paraphrase.
//
// SELF-LIMITING AND RESUMABLE. Sixty-one companies cannot be researched in one
// invocation: an Edge Function has a compute ceiling. The loop watches the clock,
// stops before starting work it cannot finish, and skips companies this run has
// already covered - so the same call can simply be sent again until `remaining`
// reaches zero.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UA = "gtm-signals-collector/1.0 (+https://github.com/knife-co)";
const FETCH_TIMEOUT_MS = 10000;
const RUN_BUDGET_MS = 70000;
const DEFAULT_BATCH = 15;
const MAX_BATCH = 40;
const MAX_BODY_CHARS = 6000;
const MAX_BODIES_PER_COMPANY = 2;

type Eh = { field: string; claim: string; raw_excerpt: string; source_type: string; source_url: string | null };

async function get(url: string): Promise<{ code: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: ctrl.signal });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    return { code: r.status, body };
  } finally { clearTimeout(t); }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

// Greenhouse returns HTML that has itself been escaped - `&lt;p&gt;` rather than
// `<p>`. Stripping tags before decoding entities therefore leaves every tag in
// place, because at strip time they are not yet tags. Decode, strip, decode again.
//
// Not cosmetic: the gate checks a quoted span against this text, so tags left in
// the source make honest drafts fail to match and inflate the rejection rate.
function htmlToText(html: string): string {
  let s = decodeEntities(String(html ?? ""));
  s = s
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Returns the body, or the reason it could not be read. "This ATS exposes no
// description" and "the fetch failed" are different problems with different fixes,
// so the reason is reported rather than collapsed into a null.
async function fetchBody(ats: string, token: string, jobId: string): Promise<{ text: string | null; url: string | null; note: string }> {
  const t = encodeURIComponent(token);
  try {
    if (ats === "greenhouse") {
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs/${encodeURIComponent(jobId)}`);
      if (r.code !== 200) return { text: null, url: null, note: `greenhouse HTTP ${r.code}` };
      const text = htmlToText(r.body?.content ?? "");
      return { text: text || null, url: r.body?.absolute_url ?? null, note: text ? "ok" : "greenhouse returned no content field" };
    }
    if (ats === "lever") {
      const r = await get(`https://api.lever.co/v0/postings/${t}?mode=json`);
      if (r.code !== 200 || !Array.isArray(r.body)) return { text: null, url: null, note: `lever HTTP ${r.code}` };
      const j = r.body.find((p: any) => String(p.id) === String(jobId));
      if (!j) return { text: null, url: null, note: "lever posting no longer listed" };
      const lists = Array.isArray(j.lists) ? j.lists.map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`).join("\n\n") : "";
      const text = [htmlToText(j.description ?? ""), lists].filter(Boolean).join("\n\n").trim();
      return { text: text || null, url: j.hostedUrl ?? null, note: text ? "ok" : "lever returned no description" };
    }
    if (ats === "ashby") {
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`);
      if (r.code !== 200 || !Array.isArray(r.body?.jobs)) return { text: null, url: null, note: `ashby HTTP ${r.code}` };
      const j = r.body.jobs.find((p: any) => String(p.id) === String(jobId));
      if (!j) return { text: null, url: null, note: "ashby posting no longer listed" };
      const plain = String(j.descriptionPlain ?? "").trim();
      const text = plain || htmlToText(j.descriptionHtml ?? "");
      return { text: text || null, url: j.jobUrl ?? null, note: text ? "ok" : "ashby board API exposes no description field" };
    }
    return { text: null, url: null, note: `unknown ats ${ats}` };
  } catch (e) {
    return { text: null, url: null, note: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_BUDGET_MS;

  let input: any = {};
  try { input = await req.json(); } catch { input = {}; }

  const maxCompanies = Math.max(1, Math.min(Number(input.limit ?? input.max_companies ?? DEFAULT_BATCH), MAX_BATCH));
  const only: string[] | null = Array.isArray(input.company_keys) && input.company_keys.length ? input.company_keys : null;
  const goodFitOnly = input.good_fit_only === true;

  // Pull the whole candidate list, then decide what is left to do. Paging at the
  // SQL level would skip companies rather than resume them.
  const { data: jobs, error: jErr } = await db.rpc("p9_jobs_to_research", {
    p_limit: 1000, p_keys: only, p_good_fit_only: goodFitOnly,
  });
  if (jErr) return new Response(JSON.stringify({ error: jErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  if (!jobs?.length) return new Response(JSON.stringify({ error: "no open GTM job postings match" }), { status: 404, headers: { "Content-Type": "application/json" } });

  // One draft per company, so all of a company's open roles become one evidence set.
  const byCompany = new Map<string, any[]>();
  for (const j of jobs as any[]) {
    if (!byCompany.has(j.company_key)) byCompany.set(j.company_key, []);
    byCompany.get(j.company_key)!.push(j);
  }

  let runId: string = input.run_id ?? "";
  if (!runId) {
    const { data: run, error: rErr } = await db.from("p9_runs")
      .insert({ notes: `research: ${jobs.length} open jobs, ${byCompany.size} companies`, company_count: byCompany.size })
      .select("run_id").single();
    if (rErr) return new Response(JSON.stringify({ error: rErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    runId = run!.run_id;
  }

  // Resume: skip companies this run already has evidence for.
  const { data: haveEvidence } = await db.from("p9_evidence").select("company_key").eq("run_id", runId);
  const doneKeys = new Set((haveEvidence ?? []).map((e: any) => e.company_key));
  const pending = [...byCompany.entries()].filter(([k]) => !doneKeys.has(k));
  const batch = pending.slice(0, maxCompanies);

  if (!batch.length) {
    return new Response(JSON.stringify({
      run_id: runId,
      message: "every candidate company already has evidence in this run",
      companies_total: byCompany.size, companies_done: doneKeys.size,
      next_step: "call p9-draft with this run_id",
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const report: any[] = [];
  let stoppedEarly = false;
  let processed = 0;

  for (const [companyKey, roles] of batch) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }

    const rows: Eh[] = [];
    const notes: string[] = [];
    let bodyChars = 0;

    // Several open GTM roles at once is a fact in its own right, and a stronger
    // one than any single title. Stored as evidence so the drafter can cite it.
    if (roles.length > 1) {
      rows.push({
        field: "open_role_count",
        claim: `They have ${roles.length} go-to-market roles open at the same time`,
        raw_excerpt: roles.map((r: any) => r.job_title).join("; "),
        source_type: "signal_record",
        source_url: roles[0].job_url ?? null,
      });
    }

    for (let i = 0; i < roles.length; i++) {
      const r = roles[i];
      const tag = roles.length > 1 ? ` (role ${i + 1})` : "";

      for (const [field, label, value] of [
        ["title", "They are hiring for the role", r.job_title],
        ["function", "The role sits in this function", r.job_function],
        ["seniority", "The role is at this seniority", r.seniority],
        ["location", "The role is based here", r.location],
      ] as Array<[string, string, string]>) {
        if (value && String(value).trim()) {
          rows.push({
            field: field + tag,
            claim: `${label}${tag}: ${String(value).trim()}`,
            raw_excerpt: String(value).trim(),
            source_type: "signal_record",
            source_url: r.job_url ?? null,
          });
        }
      }

      if (i < MAX_BODIES_PER_COMPANY) {
        const b = await fetchBody(r.ats, r.token, r.job_id);
        notes.push(`${r.ats}:${r.job_id} ${b.note}`);
        if (b.text) {
          const text = b.text.slice(0, MAX_BODY_CHARS);
          bodyChars += text.length;
          rows.push({
            field: "description" + tag,
            claim: `Full job description for ${r.job_title}`,
            raw_excerpt: text,
            source_type: "job_posting",
            source_url: b.url ?? r.job_url ?? null,
          });
        }
      }
    }

    if (rows.length) {
      const { error: iErr } = await db.from("p9_evidence")
        .insert(rows.map((r) => ({ run_id: runId, company_key: companyKey, ...r })));
      if (iErr) {
        report.push({ company_key: companyKey, evidence: 0, note: `insert failed: ${iErr.message}` });
        continue;
      }
    }

    processed++;
    report.push({
      company_key: companyKey,
      company: roles[0].company_name,
      gate_passed: roles[0].gate_passed,
      open_roles: roles.length,
      evidence: rows.length,
      description_chars: bodyChars,
      has_html_leak: rows.some((r) => /<\/?(p|div|br|strong|ul|li|span|h[1-6])\b/i.test(r.raw_excerpt)),
      notes,
    });
  }

  const withBody = report.filter((r) => (r.description_chars ?? 0) > 0).length;
  const leaking = report.filter((r) => r.has_html_leak).length;
  const remaining = Math.max(0, pending.length - processed);

  return new Response(JSON.stringify({
    run_id: runId,
    companies_total: byCompany.size,
    companies_this_call: processed,
    remaining,
    stopped_on_time_budget: stoppedEarly || undefined,
    elapsed_ms: Date.now() - startedAt,
    companies_with_a_description: withBody,
    companies_with_html_left_in: leaking,
    next_step: remaining > 0 ? "send this exact call again" : "call p9-draft with this run_id",
    detail: report,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
