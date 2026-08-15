#!/usr/bin/env node
/**
 * The Operator's judgment, written down as code instead of trusted to a prompt.
 *
 *   node agents/operator-triage.mjs                                  # the shipped fixture
 *   node agents/operator-triage.mjs --input path/to/messages.json    # another fixture
 *   node agents/operator-triage.mjs --json                           # machine-readable
 *   node agents/operator-triage.mjs --faq path/to/draft-faq.md       # dry-run a draft FAQ
 *
 * WHY THIS IS A SCRIPT AND NOT JUST THE PROMPT IN agents/operator.md
 *
 * operator.md tells a model "if it involves a refund, a complaint, a legal
 * question, a price or scope negotiation, a timeline commitment, or anything
 * not covered in faq.md, do not reply." That instruction is correct and it is
 * also re-interpreted from scratch on every single run, by a model that has
 * just read a persuasive email arguing it is an exception. The gates that
 * protect money, scope, time and legal exposure should not be re-derived from
 * natural language a hundred times; they should be a list you can read, test,
 * and diff. This file is that list.
 *
 * The prompt still does the writing. This does the sorting, the same way every
 * time, offline, with no model in the loop.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 *
 * It has no mailbox connector and never opens one. Input is a local JSON
 * fixture of invented messages. Wiring it to a real inbox is a decision for
 * Evans, made once he has watched a week of its output — not something a build
 * step gets to do on his behalf.
 *
 * WHY EVERYTHING ESCALATES TODAY
 *
 * faq.md ships with every answer empty, on purpose: an invented policy is the
 * failure it exists to prevent. With nothing answered, the "answer" branch has
 * nothing to draw on and every message lands on "escalate". That is the system
 * working, not a bug — and the summary says so in those words so nobody
 * "fixes" it by loosening a gate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFaq, FAQ_PATH } from './faq-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = join(ROOT, 'agents', 'fixtures', 'inbox-sample.json');

/* ------------------------------------------------------------------- rules */

/**
 * THE ESCALATION GATES — from agents/operator.md and the "Escalate always"
 * block at the top of agents/faq.md.
 *
 * These fire before any FAQ lookup, and a hit is final. That ordering is the
 * whole point: the dangerous case is not "no FAQ entry looked close", it is
 * "an FAQ entry looked close enough to a refund request that the Operator
 * answered it." Cost of a wrong escalation: thirty seconds of Evans's time.
 * Cost of a wrong send: a refund promised that he never agreed to, a timeline
 * he cannot hit, or a sentence his client's lawyer gets to read back to him.
 * The asymmetry is not close, so the gates are deliberately broad and no gate
 * has an "unless the FAQ covers it" clause.
 */
export const GATES = [
  {
    id: 'refund',
    why: 'refunds are money leaving Evans\'s account — his decision, never the Operator\'s',
    re: /\brefunds?\b|\brefunded\b|\bmoney back\b|\bcharge ?back\b|\breimburse\w*\b|\bcredit note\b/i
  },
  {
    id: 'complaint',
    why: 'an unhappy client is a relationship problem, and a fast automated reply reads as a brush-off',
    re: /\bcomplain\w*\b|\bunhappy\b|\bdissatisf\w*\b|\bdisappoint\w*\b|\bunacceptable\b|\bfrustrat\w*\b|\bpoor (quality|service|work)\b|\bnot what (i|we) (asked|agreed|expected)\b|\bthis is the second time\b/i
  },
  {
    id: 'legal',
    why: 'anything a lawyer will later read must be written by the person who signs it',
    re: /\blegal\b|\blawyer\b|\battorney\b|\bcounsel\b|\bNDA\b|\bnon-?disclosure\b|\bcontract\b|\bindemnif\w*\b|\bliabilit\w*\b|\bterms (and|&) conditions\b|\bsue\b|\blawsuit\b|\bbreach\b|\bsubpoena\b/i
  },
  {
    id: 'price-or-scope-negotiation',
    why: 'a number sent in a negotiation is a number Evans is then held to',
    /* Note the shape: this gate is about NEGOTIATING, not about the word
       "price". A neutral "what are your rates?" falls through to the FAQ,
       because faq.md explicitly allows quoting a figure that is written there
       as a fixed published number. "Can you do it for $2,000 instead?" is a
       different act and never gets an automatic answer. */
    re: /\bdiscount\w*\b|\bnegotiat\w*\b|\bcheaper\b|\blower (the )?(price|rate|fee)\b|\bknock (something )?off\b|\bmeet (us|me) (at|there)\b|\bfor \$[\d,]+ instead\b|\binstead of \$[\d,]+\b|\babove (our|my) budget\b|\bout of (our|my) budget\b|\bmatch (their|a competitor)\b|\bextra (work|scope|deliverable)\b|\badd(ing)? .{0,20}\bto the scope\b|\bsame scope for\b/i
  },
  {
    id: 'timeline-commitment',
    why: 'operator.md: never promise a timeline on Evans\'s behalf — he is the one who has to hit it',
    /* Again the distinction is commitment vs. curiosity. "How long does a
       typical engagement take?" is an FAQ topic. "Can you commit to delivering
       by September 1?" is a promise, and promises are Evans's to make. */
    re: /\bdeadline\b|\bcommit(ment|ting)?\b|\bguarantee\w*\b|\bpromise\w*\b|\bdeliver(ed|ing|y)? (it |the .{0,30})?by\b|\bdone by\b|\bfinished by\b|\bready by\b|\bbefore the (board|meeting|launch|deadline)\b|\bby (mon|tues|wednes|thurs|fri|satur|sun)day\b|\bby (january|february|march|april|may|june|july|august|september|october|november|december)\b|\bfirm (yes|date|commitment)\b|\bASAP\b|\brush\b/i
  },
  {
    id: 'failed-payment',
    why: 'a payment problem is money and relationship at once, and the Operator cannot see the processor',
    re: /\b(payment|card|invoice|charge|transfer|ach|direct debit)\b[^.?!]{0,40}\b(failed|declined|bounced|rejected|did ?n.?t go through)\b|\bfailed payment\b|\bpayment (issue|problem)\b|\bpast due\b|\boverdue\b|\binsufficient funds\b/i
  }
];

/**
 * NO-ACTION — the only branch that is neither answered nor escalated.
 *
 * Kept deliberately narrow. "Ignore" is the one classification that makes a
 * message disappear without a human ever seeing it, so it only fires on a
 * message that asks nothing and requests nothing: a thank-you, an
 * acknowledgement, an automated no-reply. Anything with a question mark or an
 * ask in it is not ignorable, no matter how friendly it sounds.
 */
const NO_ACTION = {
  id: 'no-action',
  why: 'a courtesy note with no question and no request — replying to it is noise',
  test(msg) {
    const text = `${msg.subject} ${msg.body}`;
    if (/\?/.test(text)) return false;
    if (/\b(can|could|would|will) you\b|\bplease\b|\bsend me\b|\bi need\b|\bi want\b|\blet me know\b|\bwaiting (on|for)\b/i.test(text)) return false;
    return /\bthank(s| you)\b|\bappreciate it\b|\bno (reply|response) (needed|necessary)\b|\bnoted\b|\bgot it\b|\bdo not reply\b|\bno-?reply@/i.test(text) || /no-?reply@/i.test(msg.from || '');
  }
};

/* ------------------------------------------------------------ FAQ matching */

const STOPWORDS = new Set([
  'what','when','where','which','who','whom','how','why','do','does','did','you','your','yours','i','me','my','we','our','us',
  'the','a','an','and','or','but','if','is','are','was','were','be','been','being','to','of','in','on','for','with','at','by',
  'from','as','it','its','this','that','these','those','can','could','would','should','will','shall','may','might','have','has',
  'had','not','no','yes','there','their','they','them','about','into','than','then','so','out','up','down','get','got','just',
  'like','need','want','please','thanks','thank','hi','hello','regards','best','long','take','right','now'
]);

const words = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));

/**
 * Find the FAQ question a message is closest to.
 *
 * A shared word list is a crude matcher and that is fine here, because the
 * consequence of a weak match is an escalation — the safe direction. It is
 * only ever allowed to produce an ANSWER when the matched entry is genuinely
 * answered by Evans, so a false positive costs a human glance, never a send.
 */
export function matchFaq(msg, entries) {
  const text = new Set(words(`${msg.subject} ${msg.body}`));
  let best = null;
  for (const entry of entries) {
    const keys = [...new Set(words(entry.question))];
    if (!keys.length) continue;
    const hits = keys.filter((k) => text.has(k));
    /* Two shared content words, or one long distinctive one ("engagement",
       "turnaround"). Below that, we are pattern-matching on noise. */
    const strong = hits.length >= 2 || hits.some((h) => h.length >= 7);
    const score = hits.length / keys.length;
    if (strong && (!best || score > best.score)) best = { entry, score, hits };
  }
  return best;
}

/* ------------------------------------------------------------------ triage */

export function triage(msg, entries) {
  for (const gate of GATES) {
    const text = `${msg.subject}\n${msg.body}`;
    if (gate.re.test(text)) {
      return {
        id: msg.id, from: msg.from, subject: msg.subject,
        classification: 'escalate',
        rule: `gate:${gate.id}`,
        reason: `${gate.id.replace(/-/g, ' ')} — ${gate.why}. Gates fire before any FAQ lookup, so a close-looking FAQ entry cannot override this.`
      };
    }
  }

  if (NO_ACTION.test(msg)) {
    return {
      id: msg.id, from: msg.from, subject: msg.subject,
      classification: 'ignore', rule: 'no-action', reason: NO_ACTION.why
    };
  }

  const match = matchFaq(msg, entries);

  if (!match) {
    return {
      id: msg.id, from: msg.from, subject: msg.subject,
      classification: 'escalate', rule: 'not-in-faq',
      reason: 'no topic in faq.md covers this. faq.md is the edge of what the Operator may say alone; outside it there is no third branch where it improvises.'
    };
  }

  if (match.entry.state === 'answered') {
    return {
      id: msg.id, from: msg.from, subject: msg.subject,
      classification: 'answer', rule: 'faq-answered',
      reason: `faq.md :: "${match.entry.question}" is answered in Evans's own words — send that answer, verbatim in tone, and add nothing to it.`
    };
  }

  if (match.entry.state === 'half') {
    return {
      id: msg.id, from: msg.from, subject: msg.subject,
      classification: 'escalate', rule: 'faq-half-filled',
      reason: `faq.md :: "${match.entry.question}" still contains a placeholder. Sending it would put "[FILL IN]" in front of a client — run agents/faq-check.mjs and finish or empty that answer.`
    };
  }

  return {
    id: msg.id, from: msg.from, subject: msg.subject,
    classification: 'escalate', rule: 'faq-unanswered',
    reason: `the closest topic in faq.md — "${match.entry.question}" — is still [FILL IN], so there is nothing to send. Escalate, then have Evans write that answer once so this topic never escalates again.`
  };
}

/* --------------------------------------------------------------------- CLI */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const inputArg = process.argv.indexOf('--input');
  const input = inputArg >= 0 ? process.argv[inputArg + 1] : DEFAULT_INPUT;
  /* --faq points at a draft FAQ. It exists so Evans can see what the Operator
     WOULD start answering before he makes those answers live — a dry run of
     his own judgment, which is the cheapest place to catch an answer he did
     not mean to hand over. */
  const faqArg = process.argv.indexOf('--faq');
  const faqPath = faqArg >= 0 ? process.argv[faqArg + 1] : FAQ_PATH;
  const JSON_OUT = process.argv.includes('--json');

  /* A hard stop rather than a comment: this tool reads a local JSON fixture,
     full stop. If it is ever handed something that is not a local .json file,
     it refuses instead of guessing that it was meant to go and fetch mail. */
  if (!input || extname(input).toLowerCase() !== '.json') {
    console.error('operator-triage reads a local JSON fixture only. It has no mailbox connector and never opens one.');
    process.exit(1);
  }
  if (!existsSync(input)) {
    console.error(`No fixture at ${input}.`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(input, 'utf8'));
  const messages = Array.isArray(raw) ? raw : raw.messages;
  if (!Array.isArray(messages)) {
    console.error('Fixture must be a JSON array of {id, from, subject, body}, or an object with a "messages" array.');
    process.exit(1);
  }

  if (!existsSync(faqPath)) {
    console.error(`No FAQ file at ${faqPath} — the Operator has no brain to consult.`);
    process.exit(1);
  }
  const entries = parseFaq(readFileSync(faqPath, 'utf8'));
  const answered = entries.filter((e) => e.state === 'answered');
  const half = entries.filter((e) => e.state === 'half');

  const results = messages.map((m) => triage(m, entries));

  if (JSON_OUT) {
    console.log(JSON.stringify({
      input: input.replace(ROOT + '/', ''),
      faq: { file: faqPath.replace(ROOT + '/', ''), total: entries.length, answered: answered.length, halfFilled: half.length },
      results
    }, null, 2));
    process.exit(0);
  }

  console.log(`Operator triage — ${input.replace(ROOT + '/', '')} (fixture; no mailbox is connected)`);
  console.log(`${faqPath.replace(ROOT + '/', '')}: ${answered.length} of ${entries.length} topic(s) answered${half.length ? `, ${half.length} HALF-FILLED` : ''}\n`);

  const w = { id: 6, cls: 9, rule: 33 };
  console.log(`  ${'ID'.padEnd(w.id)}${'ACTION'.padEnd(w.cls)}${'RULE'.padEnd(w.rule)}SUBJECT`);
  console.log(`  ${'-'.repeat(w.id + w.cls + w.rule + 34)}`);
  for (const r of results) {
    const subject = (r.subject || '').length > 34 ? r.subject.slice(0, 33) + '…' : r.subject || '';
    console.log(`  ${String(r.id).padEnd(w.id)}${r.classification.toUpperCase().padEnd(w.cls)}${r.rule.padEnd(w.rule)}${subject}`);
  }

  console.log('\nWhy each one landed where it did:\n');
  for (const r of results) console.log(`  ${r.id}  ${r.reason}`);

  const counts = results.reduce((acc, r) => ({ ...acc, [r.classification]: (acc[r.classification] || 0) + 1 }), {});
  const n = (k) => counts[k] || 0;

  console.log(`\n  answer   ${n('answer')}`);
  console.log(`  escalate ${n('escalate')}`);
  console.log(`  ignore   ${n('ignore')}`);

  if (half.length) {
    console.log(`\nWARNING: ${half.length} faq.md answer(s) are half-filled. Those topics are being escalated`);
    console.log('rather than answered, but fix them before promoting anything: run agents/faq-check.mjs.');
  }

  /* The line that stops someone "fixing" a correctly cautious system. */
  if (answered.length === 0) {
    console.log('\nVERDICT: faq.md has no answered topics, so the Operator can answer nothing on its own and');
    console.log('everything that needs a reply escalates to Evans. That is the designed behaviour of an empty');
    console.log('FAQ, not a broken triage — it starts answering the moment he writes real answers into faq.md.');
  } else {
    console.log(`\nVERDICT: ${n('answer')} message(s) can be answered from faq.md alone; ${n('escalate')} escalate to Evans; ${n('ignore')} need nothing.`);
  }

  /* Exits 0 even when everything escalates: a cautious inbox is not a failure,
     and a non-zero exit here would train someone to make the gates looser. */
  process.exit(0);
}
