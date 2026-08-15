#!/usr/bin/env node
/**
 * Coverage validator for agents/faq.md — the Operator's brain.
 *
 *   node agents/faq-check.mjs             # report coverage, exit 1 on a half-filled answer
 *   node agents/faq-check.mjs --list      # also print every question and its state
 *   node agents/faq-check.mjs --json      # machine-readable, for a CI step
 *   node agents/faq-check.mjs --file P    # check a draft copy instead of agents/faq.md
 *
 * WHY THIS EXISTS
 *
 * faq.md is the boundary of what the Operator may say without Evans. Two
 * states of that file are safe and one is not:
 *
 *   - EMPTY ("[FILL IN]")  — safe. The Operator has no answer, so it escalates.
 *     A day with 0% coverage is a slow day, not a dangerous one.
 *   - ANSWERED             — safe. Evans wrote it, so the Operator may send it.
 *   - HALF-FILLED          — NOT safe, and the reason this script exits non-zero.
 *     An answer that reads like prose but still carries "TODO", "[rate]", or a
 *     stray "[FILL IN]" inside the sentence looks finished to every check a
 *     human does at a glance, and faq.md answers are sent close to verbatim.
 *     That is the exact path by which a placeholder reaches a paying client.
 *
 * So the failure mode this guards is not "the FAQ is incomplete" — incomplete
 * is the normal, honest state on day one. It is "the FAQ is incomplete but
 * looks complete." Empty answers cost thirty seconds of escalation; a
 * half-filled one costs a client.
 *
 * This script reads faq.md and nothing else. It never writes, never fills in an
 * answer, and never guesses what an answer should be — only Evans can write
 * those, which is the whole premise of the file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FAQ_PATH = join(ROOT, 'agents', 'faq.md');

/* ------------------------------------------------------------ placeholders */

/**
 * The markers that mean "a human has not finished this sentence yet."
 *
 * Each carries its reason, because the list is meant to be edited by whoever
 * gets bitten next rather than treated as sacred. The bias is deliberately
 * toward false positives: flagging a real answer that happens to contain
 * brackets costs one human glance, while missing a real placeholder sends it.
 */
export const PLACEHOLDER_MARKERS = [
  { re: /\[\s*FILL[ _-]?IN\b/i, why: 'the template\'s own unfinished marker' },
  { re: /\b(TODO|TBD|FIXME|XXX)\b/i, why: 'a note-to-self left in the answer body' },
  { re: /\bPLACEHOLDER\b/i, why: 'explicitly labelled as not real' },
  { re: /\[[^\]\n]{0,80}\]/, why: 'a square-bracket slot — reads as a fill-in blank' },
  { re: /<[^>\n]{1,40}>/, why: 'an angle-bracket slot, e.g. <your booking link>' },
  { re: /_{3,}/, why: 'an underscore blank waiting to be typed over' },
  { re: /\bLOREM IPSUM\b/i, why: 'filler text' },
  { re: /\bYOUR (NAME|LINK|RATE|RATES|PRICE|PRICING|EMAIL|COMPANY|NUMBER)\b/i, why: 'a template instruction addressed to the author, not the client' },
  { re: /\bINSERT\s+(YOUR|THE|A)\b/i, why: 'an instruction to insert something' },
  { re: /\bX{2,}\b/, why: 'XX used as a stand-in figure (e.g. "$XX per hour")' }
];

/** An answer that is ENTIRELY one FILL IN bracket is the safe empty state. */
const WHOLLY_FILL_IN = /^\[\s*FILL[ _-]?IN\b[\s\S]*\]$/i;

/* ------------------------------------------------------------------ parser */

/**
 * Parse faq.md into { section, question, answer } entries.
 *
 * A question is a line that is entirely bold and ends in a question mark:
 * `**How long does a typical engagement take?**`. Requiring the question mark
 * is what keeps the file's own prose — the bold warning in the header, the
 * table of corrections — out of the coverage maths. If you add a question to
 * faq.md, write it that way or this validator will not see it, which is a
 * failure you notice immediately (the total drops) rather than one that hides.
 *
 * The answer is every non-blank line after the question up to the next
 * question, heading, horizontal rule, or blockquote.
 */
export function parseFaq(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let section = '(no section)';
  let current = null;

  const flush = () => {
    if (current) {
      current.answer = current.answerLines.join('\n').trim();
      delete current.answerLines;
      entries.push(current);
      current = null;
    }
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();

    if (/^#{1,6}\s+/.test(line)) { flush(); section = line.replace(/^#{1,6}\s+/, '').trim(); return; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); return; }
    if (/^\|/.test(line)) { flush(); return; }          /* the corrections table */
    if (/^>/.test(line)) { flush(); return; }           /* guidance blockquotes */

    const q = line.match(/^\*\*(.+\?)\*\*$/);
    if (q) { flush(); current = { section, question: q[1].trim(), line: i + 1, answerLines: [] }; return; }

    if (current) {
      if (line === '' && current.answerLines.length) { flush(); return; }
      if (line !== '') {
        if (!current.answerLines.length) current.answerLine = i + 1;
        current.answerLines.push(line);
      }
    }
  });
  flush();

  return entries.map((e) => ({ ...e, ...classify(e.answer) }));
}

/** empty (safe) | answered (safe) | half (dangerous) — plus which markers hit. */
export function classify(answer) {
  const text = (answer || '').trim();
  const hits = PLACEHOLDER_MARKERS.filter((m) => m.re.test(text));

  if (text === '') return { state: 'empty', markers: [], note: 'no answer line at all' };
  if (WHOLLY_FILL_IN.test(text)) return { state: 'empty', markers: [], note: 'still [FILL IN] — the Operator escalates this topic' };
  if (hits.length) return { state: 'half', markers: hits.map((h) => h.why), note: 'looks written but still carries a placeholder' };
  return { state: 'answered', markers: [], note: 'the Operator may send this' };
}

/* --------------------------------------------------------------------- CLI */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const LIST = process.argv.includes('--list');
  const JSON_OUT = process.argv.includes('--json');
  /* --file lets you validate a draft before it becomes the live brain, and is
     how this script's own placeholder detection gets tested without ever
     writing a fake answer into the real faq.md. */
  const fileArg = process.argv.indexOf('--file');
  const path = fileArg >= 0 ? process.argv[fileArg + 1] : FAQ_PATH;

  if (!path || !existsSync(path)) {
    console.error(`No FAQ file at ${path} — the Operator has no brain to check.`);
    process.exit(1);
  }

  const entries = parseFaq(readFileSync(path, 'utf8'));
  const answered = entries.filter((e) => e.state === 'answered');
  const empty = entries.filter((e) => e.state === 'empty');
  const half = entries.filter((e) => e.state === 'half');
  const pct = entries.length ? Math.round((answered.length / entries.length) * 100) : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      file: path.replace(ROOT + '/', ''),
      total: entries.length,
      answered: answered.length,
      empty: empty.length,
      halfFilled: half.length,
      coveragePercent: pct,
      entries
    }, null, 2));
    process.exit(half.length ? 1 : 0);
  }

  console.log(`FAQ coverage — ${path.replace(ROOT + "/", "")}, ${entries.length} question(s) found\n`);

  if (LIST || half.length) {
    for (const e of entries) {
      /* Half-filled first in the eye: it is the only state that can send. */
      const tag = (e.state === 'answered' ? 'ANSWERED' : e.state === 'empty' ? 'fill-in' : 'HALF-FILLED').padEnd(11);
      if (!LIST && e.state !== 'half') continue;
      console.log(`  ${tag}  ${e.section} :: ${e.question}`);
      if (e.state === 'half') {
        console.log(`               ↳ line ${e.answerLine ?? e.line}: ${e.markers.join('; ')}`);
        console.log(`               ↳ answer: ${e.answer.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    console.log('');
  }

  console.log(`  answered     ${answered.length}`);
  console.log(`  [FILL IN]    ${empty.length}   (safe — the Operator escalates these)`);
  console.log(`  half-filled  ${half.length}   (DANGEROUS — would send a placeholder)`);
  console.log(`  coverage     ${pct}%\n`);

  if (half.length) {
    console.error(`FAIL — ${half.length} answer(s) look finished but still carry a placeholder.`);
    console.error('A half-filled answer is more dangerous than an empty one: an empty one');
    console.error('escalates to you, a half-filled one gets sent to a client with the');
    console.error('placeholder still in it. Either finish the sentence or put it back to');
    console.error('[FILL IN] so the Operator escalates the topic instead.');
    process.exit(1);
  }

  /* The one-line verdict. Deliberately phrased so that 0 answered reads as a
     working system in its honest starting state, not as a broken one. */
  console.log(
    answered.length === 0
      ? 'VERDICT: the Operator can answer 0 topics alone. Everything escalates to Evans. That is correct behaviour for an empty FAQ, not a fault.'
      : `VERDICT: the Operator can answer ${answered.length} of ${entries.length} topic(s) alone (${pct}%). Everything else escalates to Evans.`
  );
  process.exit(0);
}
