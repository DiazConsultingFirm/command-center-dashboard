# The Operator — worker agent

**Posture: drafts only, until a specific task type has earned otherwise.**
This is the first agent that can touch the outside world, so it is the one
that needs a gate on it.

**Run as:** a Claude routine every few hours, or on demand.

**Reads:** `agents/faq.md` (its brain), the inbox, the content queue.

**Writes:** drafts, and the `operator` section of `data/jarvis-data.json`.

---

## Prompt

```text
You are my Operator. You handle work that does not need my judgment, and you
draft anything that does.

Email, every few hours: read new customer email and sort it.
- If the answer is in faq.md, reply directly using that answer, in my voice.
- If it involves a refund, a complaint, a legal question, a price or scope
  negotiation, a timeline commitment, or anything not covered in faq.md, do
  not reply. Draft a response and flag it for me with one line on why it needs
  me.

Publishing: when I have approved a piece of content, publish it across my
platforms and confirm exactly what went where. Never publish anything I have
not approved in this conversation or in writing.

Delegation: when something needs real work rather than a reply, hand it to the
right sub-agent instead of attempting it yourself. Say which sub-agent you
handed it to and why.

Rules:
- Never send anything about money, refunds, pricing, scope, or legal matters
  without my approval.
- Never invent a policy, a price, a rate, or a delivery date. If it is not in
  faq.md, escalate. Guessing at a policy costs me a client; escalating costs me
  thirty seconds.
- Never promise a timeline on my behalf.
- Never spend anything — credits, ad budget, subscriptions — without asking
  first, every time, no matter how small.

At the end of each run, report what you resolved, what you drafted, and what
you escalated, and write those counts into the operator section of
data/jarvis-data.json using the shape in data/jarvis-data.sample.json. Report
the real counts; if a count is unknown, write null rather than a guess.

Do not hand-edit that file. Write it by running:
  node agents/operator-report.mjs --resolved N --drafted N --escalated N --published N
and simply leave off any flag you did not measure, which writes null for you.
```

---

## Sub-agents

The Operator does not do specialist work itself — it routes. Each sub-agent
gets its own job description, its own skills, and its own connectors, written
the same way this prompt is:

| Sub-agent | Owns | Gate |
|---|---|---|
| Developer | code changes, dashboard builds, repo work | opens a draft PR, never merges |
| Content | scripts, captions, reel copy | drafts only, publishes after approval |
| Research | client and market lookups | read-only |

Add one only when you have a task type that keeps recurring. A sub-agent with
nothing to do is a prompt you have to maintain for free.

## The escalation gate is the whole safety story

Two things keep this from going wrong, and both are boundaries rather than
instructions to be careful:

1. **`faq.md` is the edge of what the Operator may answer alone.** Inside it,
   reply. Outside it, escalate. There is no third branch where it improvises.
2. **Every send that touches money, scope, or time comes to you first** —
   regardless of how confident the draft looks.

## Runbook

Three tools do the deterministic parts of this job, so the gates above are
enforced in code rather than re-derived from the prompt on every run. All three
are zero-dependency Node, and none of them can reach a mailbox.

```sh
node agents/faq-check.mjs                  # is the brain safe to use?
node agents/operator-triage.mjs            # how would it sort the inbox?
node agents/operator-report.mjs --dry-run  # what would it write to the screen?
```

**1. `faq-check.mjs` — is the brain safe to use?**

Reports how many FAQ topics are answered, and exits non-zero if any answer is
*half-filled*: prose that still carries `TODO`, `<your link>`, `$XX`, or a
stray `[FILL IN]`. An empty `[FILL IN]` is safe — the Operator escalates that
topic. A half-filled one is not, because it looks finished and answers here are
sent close to verbatim. Run it before every promotion decision and in CI.

```sh
node agents/faq-check.mjs --list           # every question and its state
node agents/faq-check.mjs --file draft.md  # check a draft before it goes live
node agents/faq-check.mjs --json           # for a CI step
```

Today it reports 0 of 15 answered, which is the honest starting state and not
a fault. Every answer in that file has to be written by Evans, in his words. No
agent may fill one in — a fabricated policy is precisely what that file exists
to prevent.

**2. `operator-triage.mjs` — how would it sort the inbox?**

Classifies each message as `answer` / `escalate` / `ignore` and prints the rule
that decided it. The escalation gates from this file — refunds, complaints,
legal, price or scope negotiation, timeline commitments, failed payments — are
encoded as an explicit list at the top of the script, and they fire **before**
any FAQ lookup, so a close-looking FAQ entry can never override one.

```sh
node agents/operator-triage.mjs                       # the shipped fixture
node agents/operator-triage.mjs --input mine.json     # another fixture
node agents/operator-triage.mjs --faq draft-faq.md    # dry-run a draft FAQ
```

Input is a local JSON fixture (`agents/fixtures/inbox-sample.json`, eight
invented messages) — it has no mailbox connector and refuses anything that is
not a local `.json` file. With faq.md empty, essentially everything escalates.
That is the design working: it starts answering the moment real answers exist.

Two distinctions worth knowing, because they are where the gates are subtle:

- A neutral *"what are your rates?"* is an FAQ topic; *"can you do it for
  $2,000 instead?"* is a negotiation and always escalates.
- *"How long does a typical engagement take?"* is an FAQ topic; *"can you
  commit to delivering by September 1?"* is a promise, and promises are yours.

**3. `operator-report.mjs` — what it writes to the screen**

The only writer for the `operator` section of `data/jarvis-data.json`. It goes
through `agents/lib/data-file.mjs`, so encoding stays canonical and a diff in
that file always means a real change.

```sh
node agents/operator-report.mjs --resolved 3 --drafted 2 --escalated 1 --published 0
node agents/operator-report.mjs --escalated 4 --dry-run
echo '{"resolved":3,"escalated":1}' | node agents/operator-report.mjs
```

A count you do not pass is written as `null` and renders as **UNAVAILABLE**,
never as `0`. "Escalated nothing today" and "nobody counted" are different
facts and the screen must not conflate them. Counts must be non-negative
integers or the run is refused rather than coerced.

### What draft-only mode means in practice

Nothing above sends. There is no send path in this repo at all, and there is no
schedule: every run is a human typing a command. Concretely, today:

1. You run `operator-triage.mjs` and read the table.
2. Everything it marks `escalate` — which is currently everything — you handle,
   or you have the Operator draft a reply that lands in your drafts folder and
   waits for you to press send.
3. You run `operator-report.mjs` with the counts from that run so the panel on
   `jarvis.html` reflects reality.
4. Anything it got wrong becomes a line in `faq.md` and a row in its
   corrections log, so it never escalates that one again.

Draft-only is not a setting to be flipped in a config file. It ends only when
you connect an inbox yourself and start promoting categories, one at a time,
by the criteria below.

## Promotion criteria

Watch every single thing it drafts for the first week before letting it send
anything on its own. Then promote it **per task type**, not wholesale: if you
have watched it answer thirty "what is your turnaround" emails correctly, let
it send that one category unattended and keep watching the rest. Autonomy is
earned one category at a time, and it can be taken back the same way.

### Checking that a category has actually earned it

Before promoting one category, all four have to be true — and the first three
are things you can check rather than feel:

1. **The FAQ topic behind it is answered in your own words.**
   `node agents/faq-check.mjs --list` shows it as `ANSWERED`, and the whole
   file reports zero half-filled answers.
2. **Triage has been putting that category in the right bucket all week**, with
   no message from that category ever landing in a gate by accident and none
   slipping past one.
3. **You have read every draft in that category** for a week and would have
   sent them unchanged. A draft you edited is a draft that was not ready.
4. **None of the six gates touch it.** Refunds, complaints, legal, price or
   scope negotiation, timeline commitments and failed payments are never
   promotable, at any level of confidence, for as long as this file stands.

Promotion is a change you make to this file and to the Operator's connectors —
adding a category to what it may send unattended — not something any of these
three scripts can do on their own. That asymmetry is the point.
