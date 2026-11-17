# Findings

Measured 13 and 16 November 2026 over a single run: 61 companies with an open
go-to-market job posting, 532 evidence rows, 61 drafts, 119 citations.

Where a finding contradicts something claimed earlier in the build, the correction is
here too.

---

## 1. The gate caught no hallucinations, because there were none

The span check exists to catch a model inventing facts. Across 61 drafts it fired four
times. **All four were false positives.**

| Draft | Flagged because | What it actually was |
| --- | --- | --- |
| AfterShip | quote field was null | malformed citation object |
| BeyondTrust | *"owning the analytic backbone…"* not found | source says *"own"* — one word's tense |
| Cribl | *"build AI-powered experiences…"* not found | source says *"build, **and scale**, AI-powered…"* — two words dropped from the middle |
| FireMon | *"RevOps Analyst"* not in cited evidence | it **is** the literal job title, stored in a different evidence row; the draft cited the description instead |

**Zero fabrications in 119 citations.** Not a funding round, not a headcount, not a
customer.

The clearest case: Fleetio's draft said *"recently raised $450M in your Series D
funding round in March of 2025"* — precisely the kind of claim that burns a lead
permanently if wrong. The posting says, word for word:

> We raised $450M in our Series D funding round in March of 2025

Given real evidence and a requirement to cite it, the model did not invent.

### The span check's precision was 0 of 4

Strict substring matching cannot distinguish a fabrication from a quote adapted by one
word. It is worth keeping — it is the only mechanism that *could* catch an invention,
and its failure mode is a false rejection rather than a sent lie — but the honest
framing is that it is paying a premium against something that did not happen.

Two fixes worth testing: tell the drafter to copy quotes character-for-character and
adapt the prose around them; loosen the match to tolerate inflection.

### One gap the check cannot close

The Fleetio draft added the word **"recently"**, which is not in the evidence. March
2025 to November 2026 is twenty months. The gate verifies that the cited quote exists,
not that the sentence built around it is faithful. **Grounding catches invented facts,
not spin applied to real ones.**

---

## 2. The rejection rate is a property of the gate, not the drafts

Two separate changes, each leaving the drafts untouched:

| Change | Rejected | Rate |
| --- | --- | --- |
| Ruleset 1 | 4 of 61 | **6.6%** |
| Ruleset 2 — 13 phrases added to a list | 42 of 61 | **68.9%** |

| Judge model (same six drafts, 13 Nov) | Rejected | Rate |
| --- | --- | --- |
| `gemini-3.5-flash` | 5 of 6 | **83.3%** |
| `gemini-3.1-flash-lite` | 0 of 6 | **0%** |

Draft 5 in that second comparison scored **2 out of 10 on usefulness** from one judge
and **9** from the other, on the identical 29 words.

> An AI quality gate's pass rate is not a property of the output. Reporting one
> without naming the ruleset and the judge communicates nothing.

### Ruleset 1's banned-phrase list caught nothing at all

Thirty-one cold-email clichés — *"hope this finds you well"*, *"circle back"*,
*"synergy"*, *"move the needle"* — and **zero of 61 drafts** used any of them.

The model opened **42 of 61** with *"I saw"* or *"I noticed"*. That family wasn't on
the list. Ruleset 2 adds it and catches 41.

The list encoded a 2015 idea of what machine-written outreach sounds like. The machine
had moved on.

---

## 3. The real failure mode is invisible to every rule

| Failure mode | Count of 61 | Catchable by a rule? |
| --- | --- | --- |
| Generic hiring opener | 42 | Yes — ruleset 2 |
| Offers **recruiting services** | 10 | No |
| Echoes the job ad back | several | No |
| Citation bookkeeping errors | 4 | Only as false positives |

The recruiting misread is the interesting one. The model reads "this company is
hiring" and concludes the sender must be a recruiter — *"source and screen qualified
candidates"*, *"own full-cycle recruiting"*, *"build strong talent pipelines"*.

Nothing false is asserted, so no deterministic rule touches it. It happens because
**the prompt never says what the sender sells**, and every piece of evidence is a job
posting, so recruiting is a reasonable inference and a wrong one.

**Grounded in their facts, wrong about mine.**

The model judge caught what the rules could not: GitLab's recruiting draft scored
`specific: 3, useful: 4`; Dropbox's scored `specific: 3`. Both passed every rule.

> So the two layers fail in opposite directions. The code flags honest adaptation; the
> model misses nothing on grounding but is the only thing that sees a draft offering
> the wrong service. Neither is sufficient alone.

---

## 4. Buying signals do not decay gently — they vanish

The first version of the researcher selected companies and fetched the posting named
on the signal. It returned 404.

The signal fired 12 October. The posting closed 17 October — five days later.

**Signals keep a snapshot; the job board keeps the truth.** Rewritten to target only
postings still open, which produced the real denominator:

- **109 open GTM postings across 64 companies** on 13 November
- **61 companies** on 16 November — three closed over the weekend
- Of the 64, only **9** had passed the ICP gate; 55 had been rejected by it

A third of the companies (22 of 61) have **more than one** GTM role open at once. That
is the strongest single fact available and one no bought list carries.

---

## 5. What the model judge saw, where it could be run

The free tier's daily quota ran out at 28 of 61 scored, and the set is split between
two judges after the first began returning sustained 503s.

- **25 of 28 scored `grounded: 10`**, agreeing with the span check that nothing was invented
- **11 of 28** fell below the pass mark of 7 — all on *specific*, *useful* or *natural*, never on *grounded*

One draft scored 10 on grounded and 10 on specific, then **2 on useful**: true,
specific, and saying nothing worth reading. That is the real failure mode of grounded
AI copy, and it is now measured rather than asserted.

---

## A claim that was wrong, and the correction

Mid-run, two `ungrounded_quote` rejections were read as the span check catching
fabrications that the judge model had scored `grounded: 10/10` — the perfect
vindication of a two-layer design.

Checking the source text showed both were near-quotes: one dropped two words, one
changed a verb's tense. **The judge was right in substance and the code was right in
letter.** The comfortable version of the argument did not survive the data.
