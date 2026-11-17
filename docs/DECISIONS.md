# Decisions

What was chosen, what was reversed, and the bugs worth knowing about. Dated, because
several of these overturn an earlier call.

---

## Evidence stores both a claim and a raw excerpt (13 Nov)

**Decision.** Every evidence row keeps the readable wording *and* the exact source
text it came from, in separate columns.

**Why.** The gate matches a draft's citation against `raw_excerpt` only. If just the
paraphrase were stored, the check would compare one model's output against another
model's output, which proves nothing. The raw excerpt is the only thing in the chain
no model wrote.

---

## Gate results live in their own table (13 Nov)

**Decision.** `p9_gate_results` is unique on `(draft_id, ruleset_version)` rather than
hanging off the draft row.

**Why.** The rules change — that is the entire point. If the verdict lived on the
draft, re-running would destroy the previous verdict and the comparison would be lost.
This is what made the 6.6% → 68.9% measurement possible at all.

---

## The gate fails closed (13 Nov, reversing version 1)

**Decision.** If the evaluator was meant to score a draft and did not, the draft is
rejected.

**Why the reversal.** Version 1 treated a missing score as "no objection". The judge
was 404ing on an uncallable model, every draft passed on rules alone, and the summary
reported a clean **0% rejection rate** — a quality gate silently approving everything
while its judge was dead. That is the exact class of failure the project exists to
catch, sitting inside the thing meant to catch it.

The judge is now probed once before anything is scored, so a dead model stops the run
instead of being discovered sixty drafts later, or never.

---

## The evaluator runs even when the rules have already failed (13 Nov)

**Decision.** One extra call per draft, spent on drafts that are already rejected.

**Why.** It buys the only comparison that matters between the two layers: how often
each catches what the other misses. Finding 3 exists because of this.

---

## `overall` is the lowest sub-score, never the average (13 Nov)

**Why.** Averaging lets a 2 on *grounded* hide behind a 9 on *natural*. A draft that
invents a fact is not rescued by good writing.

---

## Research targets open postings, not signals (16 Nov, reversing the first build)

**Decision.** Candidates come from the job board's live state, never from the signal
row.

**Why the reversal.** The first version fetched the posting named on the signal and
got a 404. The signal fired 12 October; the posting closed 17 October. Signals keep a
snapshot; `ats_jobs` keeps the truth.

---

## Every stage is self-limiting and resumable (16 Nov)

**Decision.** Each function watches the clock, stops before it is killed, skips
completed work and reports `remaining`.

**Why.** Version 5 of the gate was killed with `WORKER_RESOURCE_LIMIT`. A smaller
batch size cannot fix this, because latency is not knowable in advance — one judge
model took 85 seconds per draft, another took 1.7. Dying halfway writes nothing and
reports nothing; stopping deliberately does both.

---

## The judge is a different model from the drafter (13 Nov, compromised 16 Nov)

**Decision, then and now.** A model should not grade its own output.

**What happened.** On 16 November Google returned sustained 503s on the judge model
mid-run, and the remaining drafts were scored by the same model that wrote them. The
`judge` field is recorded on every verdict so the mixed set is visible rather than
hidden, and rates drawn from that layer are reported separately.

**What makes it tolerable.** The independence was buying less than claimed: on the two
cases where the layers disagreed, the judge was right and the code was wrong.

---

## Models are pinned to exact versions, never `-latest` (13 Nov)

**Why.** The project compares prompt versions against each other. If the provider
swaps what `latest` points to mid-experiment, the before-and-after measures a model
change and a prompt change at once, and neither can be separated.

---

## Bugs worth knowing about

**`ListModels` returns models you cannot call.** `gemini-2.5-flash-lite` is listed and
404s on use: *"no longer available to new users."* Listing is not permission. The
`{"action":"models"}` mode exists because of this, and is still not sufficient.

**HTTP 200 with no content.** On 3.x models the internal reasoning tokens come from the
same budget as the answer. A 32-token probe spent all 32 thinking and returned an empty
success. Fixed with `thinkingConfig: {thinkingBudget: 0}`, larger budgets, and
`finishReason` plus token counts in the error — *"empty response"* alone is not
diagnosable.

**Not every model accepts `thinkingConfig`.** `gemini-3.1-flash-lite` does;
`gemini-3.5-flash-lite` answers HTTP 400 *"Request contains an invalid argument."* and
names no field. A fallback that only triggered on the word "thinking" never fired, and
every draft in a batch failed. **Any 400 now retries once without the field.** The same
bug was left in the gate for two hours after being fixed in the drafter.

**Ten failed rows nearly became ten rejections.** Those failures were a client-side
configuration fault, not the model refusing to draft. Left in place, the gate would
have counted them as quality rejections and reported a rate that meant nothing. They
were deleted. A circuit breaker now stops a batch after three identical failures,
because when every call fails the same way the fault is configuration, not content.

**Resume treated failures as finished.** Rate-limited companies would never have been
drafted. Resume now skips successes only, and clears the old failed row before
replacing it.

**The free tier limits requests per minute, not only per day.** Ten calls in 25 seconds
returned 429. Drafting is paced at 4.5s between calls.

**HTML that is itself escaped.** Greenhouse returns `&lt;p&gt;` rather than `<p>`.
Stripping tags before decoding entities leaves every tag in place, because at strip
time they are not yet tags. Decode, strip, decode again. Not cosmetic: tags left in the
source make honest drafts fail the span check and inflate the rejection rate.

**PostgREST serves only `public`.** The warehouse lives in `analytics`. Exposing that
schema to the API so one function could read five columns would have opened seventeen
tables to the internet; a `security definer` function does the selection in the
database instead.
