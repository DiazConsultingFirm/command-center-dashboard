# J.A.R.V.I.S. — one screen, three agents

A personal AI assistant that tracks the numbers, handles the email, and tells
you what to focus on. `jarvis.html` is the screen you talk to; the three agents
in `agents/` do the work behind it and report back to that one place.

```
  Scout ──┐
          ├──▶  data/jarvis-data.json  ──▶  jarvis.html  (mission control)
Operator ─┤
  Advisor ┘
```

## What is here

| File | What it is |
|---|---|
| `jarvis.html` | The mission control screen. Open it in a browser — no build step, no dependencies, no server required. |
| `data/jarvis-data.sample.json` | The contract the agents write. Copy to `data/jarvis-data.json` to go live. |
| `agents/scout.md` | Gathers the numbers every morning. Read-only. |
| `agents/operator.md` | Handles email and publishing. Drafts only until promoted. |
| `agents/advisor.md` | Turns the other two into three ranked actions a day. |
| `agents/faq.md` | The Operator's brain, and the boundary of what it may answer alone. |

`index.html` is a different thing and is not part of this: it is the DCF
Command Center, regenerated from the vault by the auto-update job. Do not
hand-edit it — changes there are overwritten on the next run.

## Build order — each one earns the next

1. **The screen**, even on fake data. A system you can see is a system you keep
   using; this is the step people skip and the reason most setups die in a week.
2. **The Scout**, because it is read-only and cannot break anything. The safest
   place to learn how routines behave.
3. **The Operator**, and watch every single thing it drafts for the first week
   before you let it send anything on its own.
4. **The Advisor**, once the Scout has enough history to give it something real
   to reason about.
5. **Real data**, replacing the mock object one field at a time.

## Using the screen

Open `jarvis.html` in Chrome or Edge (Safari and Firefox render everything, but
speech *input* is Chromium-only; the text box works everywhere).

- **Click the orb** or **hold space** to talk. Release to send.
- **Type** in the box and hit enter if you would rather not talk.
- **MORNING BRIEF** delivers the spoken briefing, then the Advisor's top three.
- **VOICE: ON/OFF** mutes spoken output. **Esc** stops it mid-sentence.

It picks a British voice when the system has one installed (`Daniel`,
`Google UK English Male`, and so on), falling back through `en-GB` to any
English voice. For the proper Jarvis voice, wire ElevenLabs in front of the
speech synthesis call in `speak()`.

The assistant has no model behind it — it answers **only** from the data
object. Ask it something not wired and it says so instead of inventing an
answer. That is a feature of a screen you are meant to trust at a glance.

## Going live, field by field

The header carries a **DATA** pill: `MOCK`, `n/8 LIVE`, or `LIVE`. It is the
one thing on the screen you should look at before believing any other number.

The fastest route to real numbers is already built. The Command Center mirror
is itself a source, so the Scout can read it with no connectors at all:

```sh
node agents/scout-vault.mjs --dry-run   # show what it found, write nothing
node agents/scout-vault.mjs             # write data/jarvis-data.json
python3 -m http.server                  # then open jarvis.html
```

That gets you **7 of 8 sections live** — money, the book of work, the pipeline,
and the radar, all read from `index.html` and stamped with the mirror's own
date. Zero dependencies, read-only, and it prints an audit line per field so
you can see exactly what it read and what it could not.

Two things it deliberately will **not** do:

- **Author recommendations.** Gathering and advising are different jobs. The
  screen says the Advisor has not run rather than reading invented advice
  aloud. That section goes live when you turn the Advisor on.
- **Set your target.** A target is a decision, not a data source, so it stays
  tagged PLACEHOLDER and the status reads `NO TARGET SET` until you put a real
  number in. Once set, the Scout preserves it across every future run and
  starts reporting real pace.

For anything the mirror does not carry (a payment processor, the inbox), add
it the same way, one section at a time. Sections you never write keep their
mock values and stay flagged as mock — which is correct, and much better than
a live badge over a stale guess.

Note `fetch` cannot read a local file over `file://`, so opening the page
directly always falls back to mock data — and says so in the DATA pill.

Each metric is `{ v, source, asOf }`. `v: null` renders as **UNAVAILABLE** in
amber and the assistant refuses to reason about it out loud.

### Keeping it fresh

`.github/workflows/refresh-jarvis-data.yml` reruns the Scout whenever the
auto-update job pushes a new `index.html`, plus once daily as a safety net,
and commits the result. The published screen is therefore never staler than
the mirror it reads. The workflow only ever writes `data/jarvis-data.json`,
and its push trigger ignores that path, so it cannot retrigger itself.

> **The rule that makes committing that file safe:** it may only ever hold
> figures already public in `index.html`. The Scout reads nothing else. If you
> later wire a private source — inbox contents, an unpublished deal, anything
> from the deliberately excluded job-search notes — that section does not
> belong in this repo, because this repo is a public mirror.

### What never goes in this repo

Decided 2026-08-15, and it is not a judgement call to be re-made each time:

- **Employment income.** Salary, sign-on bonus, employer, offer terms. The
  Command Center already states that job-search detail is excluded, and this
  screen is published to a public URL. Git history is permanent, so there is no
  taking it back after the fact.
- **Anything sourced from a person rather than the mirror.** If you tell an
  agent a figure in conversation, that is not a source the Scout can read or
  re-verify tomorrow. Correct the vault note instead and let the mirror carry
  it through — the numbers here are only ever as good as their provenance.

Consulting figures — collected, outstanding, the pipeline — stay, because they
are already public in `index.html`. Nothing on this screen is more exposed than
the mirror it reads.

**Corollary worth knowing:** when a client fact changes, the fix belongs in the
vault, not here. A hand-edit would be overwritten by the next Scout run anyway,
which is the system working as intended. As the Command Center itself puts it:
a stale number means a stale note, not a broken dashboard.

Two sections the Scout passes through untouched rather than rewriting: the
Advisor's recommendations and the Operator's run counts. Those agents own
them, and a Scout rerun three hours later must not wipe the morning's advice.

### Writing to the data file

Every agent writes its section through `agents/lib/data-file.mjs`. Never hand-
edit `data/jarvis-data.json`, and never write it from a script that escapes
non-ASCII.

That is a rule with a scar behind it. The Scout writes from Node with raw
UTF-8; an agent writing the same content from Python escapes it (`—`
where the Scout puts `—`). The bytes differ, the content does not, and the
next Scout run commits a "data refresh" that changed nothing but encoding —
a history that lies about when your numbers actually moved. One writer, one
encoding, and a diff means a real change.

The lib also reports whether the file actually changed, so a run that finds
nothing new can skip the commit instead of adding noise.

### The voice

Out of the box it uses the browser's own speech synthesis, preferring a
British voice if the system has one. For the real thing, deploy
`voice/elevenlabs-proxy.js` (a Cloudflare Worker) and point
`VOICE_CONFIG.endpoint` in `jarvis.html` at it.

The key lives in the Worker as a secret, never in the page — this site is
public, and a key in a public page is a key you have given away. The proxy
still faces the world, so it checks the calling origin, caps text length so a
single call cannot run up your credits, and takes an optional shared secret.
If it is unreachable or errors, the page logs why in DIAGNOSTICS and finishes
the sentence in the browser voice rather than going silent.

## The rules that keep it safe

- **Nothing sends, spends, or publishes without you until it has earned it.**
  Drafts first, always. Promote an agent to autonomous only on the specific
  task types you have watched it get right repeatedly — never wholesale.
- **Every number carries its source and its date.** Anything unverifiable is
  labelled, never estimated. One invented figure poisons a briefing, because
  you will never know afterwards which one it was.
- **`faq.md` is the boundary.** If the answer is not in it, the Operator
  escalates instead of improvising, and you add the line afterwards so it never
  escalates that one again.
- **Read the Advisor's recommendations even on the days you do nothing with
  them.** The moment you stop reading, you own a very expensive screensaver.
