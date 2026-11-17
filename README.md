# P9 — AI outreach with a QA gate

A three-stage pipeline that researches a company, drafts a cold-email opener grounded
in that research, and then refuses to approve the draft unless it can prove every
claim.

**It was built to stop a language model inventing facts. Across 61 real companies and
119 citations it caught zero inventions, because there were none.** What it found
instead was that its own headline number is a dial rather than a measurement.

Runs entirely on free tiers: Supabase Postgres and Edge Functions, Google's Gemini
free API tier. Total spend to produce the results below: nothing.

---

## The shape of it

```
p9-research          open job postings → evidence rows
       │             (no model runs here, on purpose)
       ▼
p9-draft             evidence → two sentences + the exact text it copied
       │             (the only step where a model decides anything)
       ▼
p9-gate              four rules in code, then a model as second opinion
       │
       ▼
send_queue  or  human_review
```

### Deterministic rails, probabilistic decisions inside them

| In code | Left to a model |
| --- | --- |
| Which companies enter the queue | What evidence is worth citing |
| Fetching and storing evidence | How the opener is phrased |
| Length check | A quality score, 1–10 |
| Banned-phrase check | |
| Whether a cited fact exists | |
| Whether a quoted span appears in the source | |
| The routing decision at the threshold | |

Three probabilistic things, and only because no rule captures them. The common
mistake is the reverse: letting the model decide who to contact, then hand-checking
the wording.

---

## How grounding is enforced rather than requested

"Write an opener grounded only in the supplied evidence" is an instruction, and
instructions get ignored. Making it checkable needed a structural change.

Every evidence row stores **two** things:

- `claim` — readable wording: *"They are hiring for the role: Revenue Operations Manager"*
- `raw_excerpt` — the exact source text the claim came from

The drafter must return its opener **plus** `{evidence_id, quote}` for every fact it
used. The gate then verifies, in code, that each cited id exists for that company and
that each quoted span appears character for character in that evidence's
`raw_excerpt`.

A model that invents a funding round fails a string comparison.

**Why both columns.** If only the paraphrase were stored, the check would compare one
model's output against another model's output, which proves nothing. The raw excerpt
is the only thing in the chain no model wrote.

---

## What it found

Full write-up in [`docs/FINDINGS.md`](docs/FINDINGS.md). The short version:

**Zero fabrications in 61 drafts.** The span check fired four times; all four were
false positives — a null quote field, a verb tense (`owning` vs `own`), two words
dropped from the middle of a sentence, and a correct quote pointing at the wrong
evidence row. One draft claimed a company raised $450M in a Series D in March 2025.
The posting says exactly that, word for word.

**The rejection rate is a property of the gate, not the drafts.**

| Change | Rejection rate |
| --- | --- |
| Ruleset 1 → ruleset 2 (13 phrases added to a list) | 6.6% → **68.9%** |
| Judge model swapped (`gemini-3.5-flash` → `gemini-3.1-flash-lite`) | 83.3% → **0%** |

Same drafts in both cases.

**Ruleset 1's banned-phrase list caught nothing.** Thirty-one cold-email clichés —
*"hope this finds you well"*, *"circle back"*, *"synergy"* — and the model used none
of them. It opened 42 of 61 drafts with *"I saw"* or *"I noticed"*, which wasn't on
the list.

**The real failure mode was invisible to every rule.** Ten drafts offered to do
recruiting, because nothing in the prompt says what the sender sells and all the
evidence is job ads. Nothing false is asserted, so no rule touches it. The model judge
caught it where the rules could not.

---

## Running it

Set `GEMINI_API_KEY` as an Edge Function secret, then:

```bash
# 1. gather evidence — no model, no quota. Repeat until remaining = 0
curl -X POST .../p9-research -d '{"limit": 15}'

# 2. draft. Repeat until remaining = 0
curl -X POST .../p9-draft -d '{"run_id": "...", "prompt_version": 1}'

# 3. gate. Repeat until remaining = 0
curl -X POST .../p9-gate -d '{"run_id": "...", "max_drafts": 10}'
```

Every stage is resumable: it watches the clock, stops before the platform kills it,
skips what is already done and reports `remaining`. Sixty-one companies do not fit in
one invocation of anything.

`{"action": "models"}` on `p9-draft` lists the model ids your key can actually call —
worth running first, because `ListModels` returns models that 404 on use.

`{"evaluator": false}` on `p9-gate` runs the deterministic rules alone, with no API
calls at all.

---

## Reading order

- [`docs/FINDINGS.md`](docs/FINDINGS.md) — the measurements, with method and sample size
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — what was chosen, what was reversed, and the bugs worth knowing about
- [`analysis/rule_check.sql`](analysis/rule_check.sql) — reproduces the 6.6% / 68.9% comparison in one query, no model required
- [`prompts/`](prompts) — both prompts, verbatim and versioned

---

## Honest caveats

- **Nothing has ever been sent.** `send_queue` is a label on a row. No email left the system.
- **No human calibration.** The gate is consistent, not demonstrably correct. Until a person labels a sample and the judge is scored against it, the threshold of 7 is a line drawn on an unverified scale.
- **33 of 61 drafts have no model score.** The free tier's daily quota ran out. The headline numbers are the deterministic ones, which don't depend on it.
- **The judge set is mixed.** 16 drafts were scored by `gemini-3.1-flash-lite` and 17 by `gemini-3.5-flash-lite`, after the first began returning sustained 503s. Given that swapping the judge moved the rate 83 points, any rate drawn from that layer is confounded and is reported separately.
- **n = 61.** One industry, one signal type, one sender.
