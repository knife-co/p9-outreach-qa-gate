// P9 step 2: the drafter.
//
// The only step where a language model decides anything: phrasing is a judgement
// call, and nothing else here is. The model gets numbered evidence and must return
// its opener PLUS the evidence ids it used and the exact text copied from each.
// It is not asked to be honest - it is asked to show its working, so the gate can
// check it mechanically.
//
// SELF-LIMITING, PACED AND RESUMABLE. Sixty-one model calls do not fit in one
// invocation, and the free tier limits requests per MINUTE as well as per day:
// ten calls in twenty-five seconds returned HTTP 429. Calls are spaced, the loop
// watches the clock, and only SUCCESSFUL drafts are skipped on a retry - an
// earlier version skipped failed ones too, which would have left the rate-limited
// companies undrafted for good.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const API = "https://generativelanguage.googleapis.com/v1beta";

const CALL_TIMEOUT_MS = 30000;
const RUN_BUDGET_MS = 70000;
const PACE_MS = 4500;
const DEFAULT_BATCH = 8;
const MAX_BATCH = 25;
const EXCERPT_CAP = 4000;

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Not every model accepts thinkingConfig. gemini-3.1-flash-lite does;
// gemini-3.5-flash-lite answers HTTP 400 "Request contains an invalid argument."
// and names no field, so ANY 400 retries once without it.
async function geminiOnce(model: string, prompt: string, maxTokens: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  const call = async (disableThinking: boolean) => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: maxTokens,
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
  let last: any = null;
  for (let i = 0; i < attempts; i++) {
    const res = await geminiOnce(model, prompt, maxTokens);
    if (res.ok) return { ...res, attempts: i + 1 };
    last = res;
    if (!TRANSIENT.has(res.status) && res.status !== 0) return { ...res, attempts: i + 1 };
    const wait = Math.round(2000 * 2 ** i + Math.random() * 600);
    if (i < attempts - 1 && Date.now() + wait < deadline) await sleep(wait);
    else break;
  }
  return { ...last, attempts, transient_exhausted: true };
}

// Models wrap JSON in a markdown fence despite being told not to. Stripping it
// keeps a formatting quirk from counting as a content failure later.
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

  if (!KEY) return new Response(JSON.stringify({ error: "GEMINI_API_KEY secret is not set on this project" }), { status: 500, headers: { "Content-Type": "application/json" } });

  // ListModels returns models the key can SEE but not call, so this is necessary
  // and still not sufficient.
  if (input.action === "models") {
    const r = await fetch(`${API}/models?key=${encodeURIComponent(KEY)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok) return new Response(JSON.stringify({ error: `HTTP ${r.status}`, detail: j?.error?.message ?? null }), { status: 502, headers: { "Content-Type": "application/json" } });
    const usable = (j?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({ name: String(m.name).replace(/^models\//, ""), display: m.displayName }));
    return new Response(JSON.stringify({ usable }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const runId: string = input.run_id ?? "";
  if (!runId) return new Response(JSON.stringify({ error: "run_id is required" }), { status: 400, headers: { "Content-Type": "application/json" } });

  const maxDrafts = Math.max(1, Math.min(Number(input.max_drafts ?? DEFAULT_BATCH), MAX_BATCH));
  const pace = Math.max(0, Number(input.pace_ms ?? PACE_MS));
  const version = Number(input.prompt_version ?? 1);

  const { data: prompt, error: pErr } = await db.from("p9_prompts").select("id, body, model").eq("name", "draft").eq("version", version).maybeSingle();
  if (pErr || !prompt) return new Response(JSON.stringify({ error: `no draft prompt at version ${version}` }), { status: 404, headers: { "Content-Type": "application/json" } });
  const model = input.model ?? prompt.model;

  const { data: evidence, error: eErr } = await db.from("p9_evidence")
    .select("id, company_key, field, claim, raw_excerpt, source_type")
    .eq("run_id", runId).order("company_key").order("id");
  if (eErr) return new Response(JSON.stringify({ error: eErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  if (!evidence?.length) return new Response(JSON.stringify({ error: "no evidence for that run_id - run p9-research first" }), { status: 404, headers: { "Content-Type": "application/json" } });

  const byCompany = new Map<string, any[]>();
  for (const e of evidence) {
    if (!byCompany.has(e.company_key)) byCompany.set(e.company_key, []);
    byCompany.get(e.company_key)!.push(e);
  }

  // Resume on SUCCESSES only. A row with model_error is a company still owed a
  // draft, not one that is finished.
  const { data: haveDrafts } = await db.from("p9_drafts")
    .select("company_key, model_error").eq("run_id", runId).eq("prompt_version_id", prompt.id);
  const succeeded = new Set((haveDrafts ?? []).filter((d: any) => !d.model_error).map((d: any) => d.company_key));
  const pending = [...byCompany.entries()].filter(([k]) => !succeeded.has(k));
  const batch = pending.slice(0, maxDrafts);

  if (!batch.length) {
    return new Response(JSON.stringify({
      run_id: runId, prompt_version: version,
      message: "every company in this run already has a successful draft at this prompt version",
      companies: byCompany.size,
      next_step: "call p9-gate with this run_id",
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const report: any[] = [];
  let stoppedEarly = false, processed = 0, retries = 0, failures = 0, rateLimited = 0;

  for (let n = 0; n < batch.length; n++) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    if (n > 0 && pace) await sleep(pace);

    const [companyKey, rows] = batch[n];
    const block = rows.map((r: any) =>
      `--- EVIDENCE id=${r.id} (${r.source_type}${r.field ? ", " + r.field : ""})\nsummary: ${r.claim}\nsource text:\n${String(r.raw_excerpt).slice(0, EXCERPT_CAP)}`
    ).join("\n\n");

    const res: any = await gemini(model, `${prompt.body}\n\nEVIDENCE:\n${block}`, 900, 3, deadline);
    if (res.attempts > 1) retries += res.attempts - 1;

    // Clear any earlier failed attempt for this company before writing again.
    await db.from("p9_drafts").delete()
      .eq("run_id", runId).eq("company_key", companyKey)
      .eq("prompt_version_id", prompt.id).not("model_error", "is", null);

    if (!res.ok) {
      await db.from("p9_drafts").insert({ run_id: runId, company_key: companyKey, prompt_version_id: prompt.id, body: "", citations: [], model_error: res.error });
      processed++; failures++;
      if (res.status === 429) rateLimited++;
      report.push({ company_key: companyKey, ok: false, error: res.error });
      // Three straight rate-limit failures means the window is still closed;
      // grinding on only wastes the rest of the batch.
      if (rateLimited >= 3) { stoppedEarly = true; break; }
      if (failures >= 3 && processed === failures) { stoppedEarly = true; break; }
      continue;
    }

    const parsed = parseJson(res.text);
    if (!parsed?.body) {
      await db.from("p9_drafts").insert({ run_id: runId, company_key: companyKey, prompt_version_id: prompt.id, body: String(res.text).slice(0, 2000), citations: [], model_error: "unparseable JSON" });
      processed++; failures++;
      report.push({ company_key: companyKey, ok: false, error: "unparseable JSON" });
      continue;
    }

    const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
    const { data: ins, error: iErr } = await db.from("p9_drafts")
      .insert({ run_id: runId, company_key: companyKey, prompt_version_id: prompt.id, body: String(parsed.body).trim(), citations })
      .select("id").single();

    processed++;
    report.push(iErr
      ? { company_key: companyKey, ok: false, error: iErr.message }
      : { company_key: companyKey, ok: true, draft_id: ins!.id, citations: citations.length, body: String(parsed.body).trim() });
  }

  const remaining = Math.max(0, pending.length - (processed - failures));

  return new Response(JSON.stringify({
    run_id: runId, model, prompt_version: version,
    companies_total: byCompany.size,
    succeeded_this_call: processed - failures,
    failed_this_call: failures,
    rate_limited: rateLimited || undefined,
    remaining,
    stopped_early: stoppedEarly || undefined,
    elapsed_ms: Date.now() - startedAt,
    api_retries: retries,
    next_step: rateLimited >= 3
      ? "rate limited - wait a minute, then send this exact call again"
      : remaining > 0 ? "send this exact call again" : "call p9-gate with this run_id",
    drafts: report,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
