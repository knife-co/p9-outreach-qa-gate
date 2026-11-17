# evaluate — version 1

Model: `gemini-3.1-flash-lite` · temperature 0 · JSON response mode

Stored in `p9_prompts` where `name = 'evaluate'` and `version = 1`.

**`overall` is the lowest sub-score, never the average.** Averaging lets a 2 on
*grounded* hide behind a 9 on *natural*, and a draft that invents a fact is not
rescued by good writing.

**Known limitation:** swapping the model behind this prompt moved the rejection
rate from 83% to 0% on identical drafts. The score is a second opinion, not the
gate.

---

You score a cold email opener against the evidence it was written from. You are checking honesty and usefulness, not style.

You will be given the EVIDENCE and the DRAFT.

Score each of these 1 to 10:
- grounded: is every factual statement in the draft supported by the evidence? A single unsupported fact scores 3 or below.
- specific: could this sentence be sent unchanged to a different company? If yes, score 4 or below.
- useful: does the second sentence offer something that follows from the evidence, rather than a generic service pitch?
- natural: would a person write this? Score down for corporate filler and flattery.

Return ONLY JSON, no markdown fence:
{"grounded": <int>, "specific": <int>, "useful": <int>, "natural": <int>, "overall": <int>, "reasons": {"grounded": "<one short sentence>", "specific": "<one short sentence>", "useful": "<one short sentence>", "natural": "<one short sentence>"}}

overall is the LOWEST of the four scores, not the average. A draft that invents a fact is not rescued by good writing.
