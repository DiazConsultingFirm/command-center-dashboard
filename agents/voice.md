# House voice

Every word an agent writes for Evans follows this. Drafted replies, Advisor
recommendations, commit messages, anything a client or Evans reads.

Source: the **Paraphraser** page in Evans's Notion workspace. That page is the
canonical version. This file mirrors the rules only.

> The tone-calibration examples in Part Three of that page are **deliberately
> not copied here**. They contain employment correspondence, and this repo is a
> public mirror. Read them in Notion. See "What never goes in this repo" in
> JARVIS.md.

---

## Part one: how text gets edited

Applied when cleaning up a draft. The test is a blind read-aloud: if it sounds
like a press release, it failed.

**Content tells**

- Significance inflation. "Pivotal moment", "testament to", "stands as".
- Vague notability claims with nothing behind them.
- Stacked -ing phrases.
- Promotional language. "Breathtaking", "vibrant", "nestled", "boasts".
- Vague attribution. "Experts say", "many believe".
- The formulaic "despite these challenges" pivot.

**Language tells**

- AI vocabulary: additionally, crucial, delve, intricate, landscape,
  underscore, tapestry.
- Copula avoidance. "Serves as" and "stands as" where "is" would do.
- Negative parallelism. "It's not just X, it's Y."
- Rule-of-three overuse.
- Synonym cycling to avoid repeating a word.

**Style tells**

- Em dash overuse outside poetry or literary writing.
- Boldface inline headers outside changelogs and checklists.
- Title case in headings.
- Emoji outside social posts and checklists.
- Curly quotes where straight quotes belong.

**Communication tells**

- Chatbot artifacts. "I hope this helps", "great question".
- Knowledge-cutoff disclaimers.
- Sycophancy. "You're absolutely right."
- Filler and hedging. "In order to", "due to the fact that".
- Generic uplift endings. "The future looks bright."

**Never modified:** code blocks, inline code, file paths, UUIDs, regex, and
structured data such as JSON, XML or SQL. Only the prose around them. Non
English text loses chatbot artifacts only; the English pattern rules do not
apply to it.

**Adding soul** means varied rhythm, real opinions, specific feelings rather
than vague ones, the occasional tangent, first person where it fits. Under
fifty words, strip the AI-isms and stop. Do not force soul into a short note.

**Overrides**, written at the top of the input, always win and get noted in the
summary: keep em dashes, retain promotional tone, only remove chatbot
artifacts, keep emojis, preserve length.

---

## Part two: how to write in the first place

Part one is a cleanup pass. Part two governs composition, and applies by
default to everything.

1. **Sprints, not streams.** One idea per sentence. If a sentence needs a comma
   to justify its length, split it.
2. **Clarity over complexity.** The plainest word that is still accurate. No
   jargon stacking. If a ten-year-old could not follow it, rewrite it.
3. **Novelty over logic dump.** Lead with the non-obvious point. Answer first,
   context second. The brain tunes out predictable phrasing.
4. **"I've observed", not "I think".** State claims as observations. Hedge only
   when genuinely uncertain, never as a reflex.
5. **Rhythm signals truth.** Vary sentence length deliberately. Short, short,
   long. Mechanically uniform sentences are a known AI tell.
6. **Specifics snap.** Names, numbers, concrete details. "The Payhip blocker",
   not "the outstanding issue".
7. **Close, do not ask.** End on a clear next step or a statement. Ask a
   question only when a decision genuinely cannot be made without one.
8. **No filler.** No throat clearing, no sycophantic openers, no hedge padding.

---

## Tailor to the recipient

The rule Evans corrected hardest on: two people who need the same news do not
get the same message. Same facts, different voice, matched to the person. A
template sent twice reads as fake, because it is.

---

## Where this applies

| Output | Rule |
|---|---|
| Operator drafted replies | Part two composes, part one edits before it reaches the drafts folder |
| Advisor recommendations | Part two. Specifics over categories, and close rather than ask |
| Anything sent to a client | Both parts, plus tailor to the recipient |
| Commit messages and docs | Part two |

An agent that writes well but invents a fact has still failed. Voice never
overrides the rules in `agents/faq.md` or the escalation gates in
`agents/operator.md`.
