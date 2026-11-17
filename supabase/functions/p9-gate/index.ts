// P9 step 3: the QA gate.
//
// Four deterministic rules, then a model as a second opinion.
//
// FAIL CLOSED. Version 1 treated a missing evaluator score as "no objection".
// The judge was 404ing, every draft passed on rules alone, and the summary
// reported a clean 0% rejection rate - a quality gate silently approving
// everything while its judge was dead. A gate that cannot score a draft has not
// approved it.
//
// SELF-LIMITING. Version 5 was killed with WORKER_RESOURCE_LIMIT. The loop now
// watches the clock and stops itself, reporting what is left.
//
// Rules are versioned. Re-running at a new ruleset_version leaves old verdicts
// intact, so a rule change can be compared against what the rules used to say.
// That is what produced the 6.6% -> 68.9% measurement.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const API = "https://generativelanguage.googleapis.com/v1beta";

const CALL_TIMEOUT_MS = 30000;
const RUN_BUDGET_MS = 70000;
const DEFAULT_BATCH = 5;
const MAX_BATCH = 15;
const JUDGE_EXCERPT_CAP = 1800;

const MIN_WORDS = 12;
const MAX_WORDS = 60;
const PASS_SCORE = 7;

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ruleset 1 caught ZERO of 61 drafts. Every phrase here is a cliche the model
// never used - it opened 42 of 61 with "I saw" or "I noticed" instead.
const BANNED: Record<number, string[]> = {
  1: [
    "hope this finds you well", "hope you are well", "i came across", "came across your",
    "reaching out", "reached out", "touch base", "circle back", "quick question",
    "just wanted to", "i wanted to reach", "excited to", "thrilled to",
    "revolutioniz", "revolutionis", "game-chang", "game chang", "synergy", "synergies",
    "cutting-edge", "best-in-class", "world-class", "seamless", "needle-moving",
    "move the needle", "low-hanging fruit", "in today's fast", "as you may know",
    "i hope", "let me know if", "does that resonate",
  ],
};
// Ruleset 2 adds the openers ruleset 1 demonstrably missed. Thirteen phrases,
// and the rejection rate goes from 6.6% to 68.9% on the same 61 drafts.
BANNED[2] = [
  ...BANNED[1],
  "i saw you are hiring", "i saw you were hiring", "i saw that you",
  "i noticed you are", "i noticed you're", "i noticed that you", "i noticed your",
  "you are currently hiring", "you're currently hiring", "i see you are hiring",
  "i see that you", "we can help you", "i can help you build",
];

// Both sides of every comparison go through this. Models return curly quotes and
// em dashes where the source has straight ones; that is typography, not an
// invented fact, and failing a draft for it would be a false positive.
function norm(s: unknown): string {
  return String(s ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const wordCount = (s: string) => norm(s).split(" ").filter(Boolean).length;

// Not every model accepts thinkingConfig. gemini-3.1-flash-lite does;
// gemini-3.5-flash-lite answers HTTP 400 "Request contains an invalid argument."
// and names no field. An earlier version only retried when the message said
// "thinking", so the fallback never fired. ANY 400 now retries once without it.
async function geminiOnce(model: string, prompt: string, maxTokens: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  const call = async (disableThinking: boolean) => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0, responseMimeType: "application/json", maxOutputTokens: maxTokens,
    };
    if (disableThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const r = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    return { r, j };
  };
  try {
    let { r, j } = await call(true);
    if (r.status === 400) ({ r, j } = await call(false));
    if (!r.ok) return { ok: false as const, status: r.status, error: `HTTP ${r.status}: ${String(j?.error?.message ?? "").slice(0, 150)}` };
    const cand = j?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p: any) => p?.text).filter(Boolean).join("");
    if (!text) {
      const u = j?.usageMetadata ?? {};
      return { ok: false as const, status: 200, error: `empty response (finishReason=${cand?.finishReason ?? "none"}, thinking=${u.thoughtsTokenCount ?? 0}, output=${u.candidatesTokenCount ?? 0}, cap=${maxTokens})` };
    }
    return { ok: true as const, text };
  } catch (e) {
    return { ok: false as const, status: 0, error: String((e as Error)?.message ?? e).slice(0, 150) };
  } finally { clearTimeout(t); }
}

async function gemini(model: string, prompt: string, maxTokens: number, attempts: number, deadline: number) {
  let last: any = null; let used = 0;
  for (let i = 0; i < attempts; i++) {
    used = i + 1;
    const res = await geminiOnce(model, prompt, maxTokens);
    if (res.ok) return { ...res, attempts: used };
    last = res;
    if (!TRANSIENT.has(res.status) && res.status !== 0) return { ...res, attempts: used };
    const wait = Math.round(1500 * 2 ** i + Math.random() * 500);
    if (i < attempts - 1 && Date.now() + wait < deadline) await sleep(wait);
    else break;
  }
  return { ...last, attempts: used, transient_exhausted: true };
}

function parseJson(text: string): any | null {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
  return null;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_BUDGET_MS;

  let input: any = {};
  try { input = await req.json(); } catch { input = {}; }

  const runId: string = input.run_id ?? "";
  if (!runId) return new Response(JSON.stringify({ error: "run_id is required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const ruleset = Number(input.ruleset_version ?? 1);
  const banned = BANNED[ruleset];
  if (!banned) return new Response(JSON.stringify({ error: `no banned-phrase list for ruleset_version ${ruleset}`, available: Object.keys(BANNED) }), { status: 400, headers: { "Content-Type": "application/json" } });

  const maxDrafts = Math.max(1, Math.min(Number(input.max_drafts ?? DEFAULT_BATCH), MAX_BATCH));
  const recheck = input.recheck === true;
  const useEvaluator = input.evaluator !== false;
  if (useEvaluator && !KEY) return new Response(JSON.stringify({ error: "GEMINI_API_KEY is not set; pass {\"evaluator\": false} for the deterministic rules alone" }), { status: 500, headers: { "Content-Type": "application/json" } });

  const { data: prompt } = await db.from("p9_prompts").select("id, body, model").eq("name", "evaluate").eq("version", Number(input.prompt_version ?? 1)).maybeSingle();
  const model = input.model ?? prompt?.model ?? "gemini-3.1-flash-lite";

  // Probe the judge BEFORE scoring anything. A model that is listed but not
  // callable fails on every draft; finding that out never is how a dead gate
  // passes everything.
  if (useEvaluator) {
    if (!prompt?.body) return new Response(JSON.stringify({ error: "no evaluate prompt at that version" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const probe = await gemini(model, 'Reply with exactly {"ok":true}', 512, 3, deadline);
    if (!probe.ok) {
      return new Response(JSON.stringify({
        error: "the evaluator model is not callable, so nothing was scored and nothing was written",
        model, detail: probe.error, attempts: probe.attempts,
        hint: "try another model, or pass {\"evaluator\": false} to run the deterministic rules alone",
      }, null, 2), { status: 502, headers: { "Content-Type": "application/json" } });
    }
  }

  const { data: drafts, error: dErr } = await db.from("p9_drafts")
    .select("id, company_key, body, citations, model_error").eq("run_id", runId).order("id");
  if (dErr) return new Response(JSON.stringify({ error: dErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  if (!drafts?.length) return new Response(JSON.stringify({ error: "no drafts for that run_id" }), { status: 404, headers: { "Content-Type": "application/json" } });

  // Resume: skip drafts already judged at this ruleset. A draft rejected only
  // because the service was down is NOT finished, so it is retried.
  const { data: done } = await db.from("p9_gate_results")
    .select("draft_id, reject_category").eq("ruleset_version", ruleset);
  const settled = new Set((done ?? [])
    .filter((r: any) => r.reject_category !== "evaluator_service_unavailable" && r.reject_category !== "evaluator_unavailable")
    .map((r: any) => Number(r.draft_id)));
  const pending = recheck ? drafts : drafts.filter((d: any) => !settled.has(Number(d.id)));
  const batch = pending.slice(0, maxDrafts);

  if (!batch.length) {
    return new Response(JSON.stringify({
      run_id: runId, ruleset_version: ruleset,
      message: "every draft in this run already has a settled verdict at this ruleset_version",
      hint: "pass {\"recheck\": true} to score them again",
      drafts_in_run: drafts.length,
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const { data: evidence } = await db.from("p9_evidence").select("id, company_key, field, claim, raw_excerpt").eq("run_id", runId);
  const evById = new Map<number, any>((evidence ?? []).map((e: any) => [Number(e.id), e]));
  const evByCompany = new Map<string, any[]>();
  for (const e of evidence ?? []) {
    if (!evByCompany.has(e.company_key)) evByCompany.set(e.company_key, []);
    evByCompany.get(e.company_key)!.push(e);
  }

  const report: any[] = [];
  const tally = { checked: 0, passed: 0, rejected: 0, retries: 0, by_rule: {} as Record<string, number> };
  const bump = (k: string) => { tally.by_rule[k] = (tally.by_rule[k] ?? 0) + 1; };
  let stoppedEarly = false, outagesInARow = 0;

  for (const d of batch) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }

    const body = String(d.body ?? "");
    const cites: any[] = Array.isArray(d.citations) ? d.citations : [];

    const words = wordCount(body);
    const rule_length = !d.model_error && words >= MIN_WORDS && words <= MAX_WORDS;

    const hay = norm(body);
    const banned_hits = banned.filter((p) => hay.includes(p));
    const rule_banned_phrases = banned_hits.length === 0;

    const rule_has_citation = cites.length > 0 && cites.every((c) => c && c.evidence_id != null && typeof c.quote === "string" && c.quote.trim().length > 0);

    // The rule that would catch an invented fact. Strict substring matching:
    // it cannot tell a fabrication from a quote adapted by one word, and on a
    // 61-draft run all four of its rejections were the latter.
    const unmatched: any[] = [];
    const ownIds = new Set((evByCompany.get(d.company_key) ?? []).map((e: any) => Number(e.id)));
    for (const c of cites) {
      const id = Number(c?.evidence_id);
      const quote = String(c?.quote ?? "");
      if (!ownIds.has(id)) { unmatched.push({ evidence_id: c?.evidence_id ?? null, quote: quote.slice(0, 160), why: "evidence id does not belong to this company in this run" }); continue; }
      const src = norm(evById.get(id)?.raw_excerpt);
      if (!src.includes(norm(quote))) unmatched.push({ evidence_id: id, quote: quote.slice(0, 160), why: "quote does not appear in that evidence's source text" });
    }
    const rule_span_matches = rule_has_citation && unmatched.length === 0;
    const rulesPass = rule_length && rule_banned_phrases && rule_has_citation && rule_span_matches;

    // The evaluator runs regardless of the rules, so the two can be compared.
    let evaluator_score: number | null = null;
    let evaluator_reasons: any = null;
    let transient = false;
    if (useEvaluator && body) {
      const evBlock = (evByCompany.get(d.company_key) ?? [])
        .map((e: any) => `--- EVIDENCE id=${e.id}\nsummary: ${e.claim}\nsource text:\n${String(e.raw_excerpt).slice(0, JUDGE_EXCERPT_CAP)}`).join("\n\n");
      const res: any = await gemini(model, `${prompt!.body}\n\nEVIDENCE:\n${evBlock}\n\nDRAFT:\n${body}`, 1024, 3, deadline);
      if (res.attempts > 1) tally.retries += res.attempts - 1;
      if (res.ok) {
        outagesInARow = 0;
        const p = parseJson(res.text);
        if (p) {
          const nums = [p.grounded, p.specific, p.useful, p.natural].map(Number).filter((n) => Number.isFinite(n));
          // overall is the LOWEST sub-score: an invented fact is not offset by
          // good writing, so averaging would hide a 2 behind a 9.
          evaluator_score = Number.isFinite(Number(p.overall)) ? Number(p.overall) : (nums.length ? Math.min(...nums) : null);
          evaluator_reasons = { grounded: p.grounded, specific: p.specific, useful: p.useful, natural: p.natural, notes: p.reasons ?? null, attempts: res.attempts, judge: model };
        } else {
          evaluator_reasons = { error: "unparseable evaluator JSON", raw: res.text.slice(0, 300), judge: model };
        }
      } else {
        transient = !!res.transient_exhausted;
        evaluator_reasons = { error: res.error, attempts: res.attempts, transient, judge: model };
        if (transient) outagesInARow++;
      }
    }

    // Fail closed: if a score was meant to exist and does not, nothing is approved.
    const scoreOk = useEvaluator ? (evaluator_score != null && evaluator_score >= PASS_SCORE) : true;
    const passed = rulesPass && scoreOk;

    // A service outage is separated from a quality judgement, so the rejection
    // rate is not inflated by someone else's capacity problems.
    let reject_category: string | null = null;
    if (!passed) {
      if (d.model_error) reject_category = "model_error";
      else if (!rule_has_citation) reject_category = "no_citation";
      else if (!rule_span_matches) reject_category = "ungrounded_quote";
      else if (!rule_banned_phrases) reject_category = "banned_phrase";
      else if (!rule_length) reject_category = words > MAX_WORDS ? "too_long" : "too_short";
      else if (useEvaluator && evaluator_score == null) reject_category = transient ? "evaluator_service_unavailable" : "evaluator_unavailable";
      else reject_category = "low_evaluator_score";
      bump(reject_category);
    }

    const { error: uErr } = await db.from("p9_gate_results").upsert({
      draft_id: d.id, ruleset_version: ruleset,
      rule_length, rule_banned_phrases, banned_hits,
      rule_has_citation, rule_span_matches,
      unmatched_spans: unmatched.length ? unmatched : null,
      evaluator_score, evaluator_reasons,
      passed, route: passed ? "send_queue" : "human_review",
      reject_category, checked_at: new Date().toISOString(),
    }, { onConflict: "draft_id,ruleset_version" });

    tally.checked++;
    if (passed) tally.passed++; else tally.rejected++;

    report.push({
      draft_id: d.id, company_key: d.company_key, passed, reject_category, words, evaluator_score,
      sub_scores: evaluator_reasons && evaluator_reasons.grounded != null
        ? { grounded: evaluator_reasons.grounded, specific: evaluator_reasons.specific, useful: evaluator_reasons.useful, natural: evaluator_reasons.natural }
        : undefined,
      banned_hits: banned_hits.length ? banned_hits : undefined,
      unmatched_spans: unmatched.length ? unmatched : undefined,
      evaluator_error: evaluator_reasons?.error,
      write_error: uErr?.message,
    });

    // Three outages in a row means the service is down, not this draft.
    if (outagesInARow >= 3) { stoppedEarly = true; break; }
  }

  const outages = tally.by_rule["evaluator_service_unavailable"] ?? 0;
  const judged = tally.checked - outages;
  const qualityRejections = tally.rejected - outages;

  return new Response(JSON.stringify({
    run_id: runId,
    ruleset_version: ruleset,
    evaluator: useEvaluator ? model : "skipped (rules only)",
    checked: tally.checked,
    remaining: Math.max(0, pending.length - tally.checked),
    stopped_early: stoppedEarly || undefined,
    elapsed_ms: Date.now() - startedAt,
    passed: tally.passed,
    rejected: tally.rejected,
    rejection_rate_pct: tally.checked ? Math.round((tally.rejected / tally.checked) * 1000) / 10 : null,
    rejection_rate_excluding_outages_pct: judged > 0 ? Math.round((qualityRejections / judged) * 1000) / 10 : null,
    service_outages: outages,
    api_retries: tally.retries,
    rejected_by: tally.by_rule,
    drafts: report,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
