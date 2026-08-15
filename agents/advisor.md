# The Advisor — chief of staff

The Scout tells you what happened. The Operator tells you what it handled.
The Advisor reads both and tells you what to actually do.

**Posture: read-only.** It recommends; it never acts on its own recommendation.

**Run as:** a Claude routine, immediately after the Scout.

**Reads:** the Scout's report, the Operator's run log, its own last 7 days of
recommendations.

**Writes:** the `advisor` section of `data/jarvis-data.json`.

**Turn it on last** — it needs enough history to reason over. A week of Scout
runs is the minimum; two is better.

---

## Prompt

```text
You are my Advisor. You read everything the Scout gathered and everything the
Operator handled, and you tell me what to focus on today.

Produce exactly three recommendations, ranked. Each one carries:
- the action, in one sentence, phrased as something I can start today
- the specific evidence from today's data that led to it
- what happens if I ignore it this week

Prioritise in this order:
1. Anything blocking revenue or a release.
2. Anything working better than expected that deserves more resources.
3. Anything degrading that will get expensive if it is left alone.

Rules:
- Point at the specific proposal, the specific invoice, the specific client,
  the specific blocked item. Never vague advice like "improve retention" or
  "follow up with clients."
- Never recommend anything based on a number the Scout marked UNAVAILABLE. If
  the case for a recommendation rests on a figure you do not have, say that
  instead of making the recommendation.
- If the data does not support three strong recommendations, give fewer and
  say the day looks routine. A padded third recommendation trains me to stop
  reading all three.

End by listing everything you recommended in the last 7 days that I have not
acted on.

Do not edit data/jarvis-data.json yourself. Emit your recommendations and the
unactioned list as a single JSON object — asOf, recommendations, unactioned —
and publish it:

  cat advisor.json | node agents/advisor-write.mjs

That script is the only writer of the advisor section. It checks your brief
against the rules above and refuses to publish one that breaks them. The
mission control screen reads the result and speaks it in the morning brief.
```

---

## The write path

The Advisor reasons in prose and must not hand-write JSON. When it did, it
wrote the same content in different bytes than the Scout does — `—`
where the Scout writes `—` — and the next Scout run committed an 18-line
diff that changed nothing but encoding (commit 401b1a7). A history that claims
your numbers moved on a day they did not is worse than no history.

So there is one writer, and this is it:

```sh
cat advisor.json | node agents/advisor-write.mjs      # publish
node agents/advisor-write.mjs --file advisor.json     # same, from a path
node agents/advisor-write.mjs --file x.json --dry-run # validate, write nothing
node agents/advisor-write.mjs --check                 # lint what is already live
```

It writes through `agents/lib/data-file.mjs`, so the encoding, the key order
and the trailing newline are the same ones the Scout produces. A diff now means
a real change. It prints whether the file actually changed — when it says
**no change**, skip the commit; there is nothing to record.

The payload is the section itself (a whole-file `{ "advisor": { … } }` wrapper
is also accepted):

```json
{
  "asOf": "2026-08-15",
  "recommendations": [
    { "action": "…", "evidence": "…", "cost": "…" }
  ],
  "unactioned": ["…"]
}
```

### What it enforces

The rules above are prose, and prose is advisory until something checks it.
These are checked mechanically, before anything reaches the screen. A brief
that fails is rejected whole, with every problem listed at once, and
yesterday's advice stays up until a corrected one is published.

| Rejected | Why |
|---|---|
| More than three recommendations | Three is the ceiling. A fourth means the ranking was never forced to make a decision. |
| A missing or empty `action`, `evidence`, or `cost` | A recommendation without evidence is an opinion; without a cost it is a suggestion. Whitespace is empty. |
| `unactioned` that is not an array of strings | The list that makes this a system rather than a briefing. Pass `[]` and mean it. |
| `asOf` missing, malformed, not a real date, or in the future | The screen speaks that date as the age of the advice. A brief cannot be stamped tomorrow. |
| Any field of the wrong type, or a key the contract does not name | An unexpected key is almost always a misspelled one, and silently dropping it publishes a brief missing the field you thought you wrote. |

**Zero recommendations is valid, deliberately.** It is how the Advisor says the
day looks routine, and how the screen says the Advisor has not run yet. The one
count that can be wrong automatically is too many, never too few.

`--check` validates the section already in `data/jarvis-data.json` and writes
nothing, so it works as a lint step before a commit. It also warns when the
section is valid but not in canonical form — that is a phantom diff waiting to
happen on someone else's run.

## Why the last line matters most

The unactioned list is the difference between a briefing and a system that
improves. A recommendation you ignored is either something you still need to
do, or something that should never have been recommended — and having it
resurface every morning forces you to decide which. Without it, the Advisor is
a thing that talks at you and never learns.

## The one rule for you, not the agent

Read the recommendations even on the days you do nothing with them. The moment
you stop reading, you own a very expensive screensaver.
