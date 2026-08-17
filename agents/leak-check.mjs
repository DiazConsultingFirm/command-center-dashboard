#!/usr/bin/env node
/**
 * Fail the build if anything from the other side of the wall reaches this repo.
 *
 *   node agents/leak-check.mjs            # scan, exit 1 on a leak
 *   node agents/leak-check.mjs --json     # machine-readable
 *   node agents/leak-check.mjs --add WORD # print the hash for a new entry
 *
 * WHY THIS EXISTS
 *
 * Evans is more than one thing. Diaz Consulting Firm is his, and this repo is
 * its public mirror. His employment is not his to publish, and the two have
 * already bled: on 2026-08-16 the employer's name was found in four places
 * here, one written by an agent and three carried in from the vault mirror.
 *
 * Rules in a markdown file did not prevent that, and would not prevent it
 * again. An agent reads those rules on a good day. This runs every time.
 *
 * WHY THE LIST IS HASHED
 *
 * A plaintext list of names-that-must-never-be-public, committed to a public
 * repo, publishes exactly what it is protecting. So the terms are stored as
 * SHA-256 digests. The scanner hashes every word and adjacent word-pair in each
 * file and looks for a match, which means it can detect a term it cannot
 * itself reveal. A reader of this repo learns that a boundary exists and
 * nothing about what sits on the other side of it.
 *
 * Consequence worth knowing: this catches exact terms, not paraphrase. It is a
 * tripwire on the obvious mistake, not a censor. Judgement still lives in
 * agents/operator.md and in the instructions given to any scheduled routine.
 *
 * THE MIRROR IS SCANNED SEPARATELY
 *
 * index.html is machine-generated from the vault by a job outside this repo.
 * Editing it here is pointless; the next run overwrites it. So its hits are
 * reported against a pinned baseline: the count may not grow, and driving it to
 * zero means fixing the vault note, not this file.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(ROOT, 'agents', 'denylist.sha256');

/* The generated vault mirror. Not authored here, so not fixable here. */
export const MIRROR = 'index.html';

/* Mentions currently present in the mirror, pinned so the number cannot quietly
   grow. Lower it when the vault note is fixed and the mirror regenerates.
   Do NOT raise it to make a red build green — that is the leak getting worse.

   Counted by position, not by distinct term, so a fourth mention of a name
   already known to be there still trips it. A two-word name can score more than
   one per mention, since both the spaced and joined forms are banned. The
   number is a tripwire, not an inventory. */
export const MIRROR_BASELINE = 3;

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.github']);
const TEXT = /\.(html|md|mjs|js|json|yml|yaml|txt|css)$/i;

export const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* --add prints a digest so a new term can be banned without ever writing it
   down. Type it once here, paste the hash into the list, clear your scrollback. */
const addArg = process.argv.indexOf('--add');
if (addArg >= 0) {
  const term = process.argv.slice(addArg + 1).join(' ').trim().toLowerCase();
  if (!term) { console.error('Usage: node agents/leak-check.mjs --add SOME TERM'); process.exit(1); }
  console.log(hash(term));
  console.error(`\nAppend that line to agents/denylist.sha256. The term itself is not stored.`);
  process.exit(0);
}

if (!existsSync(LIST)) {
  console.error(`No deny-list at ${LIST}. Nothing to check against — refusing to report "clean".`);
  process.exit(1);
}

const banned = new Set(
  readFileSync(LIST, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
    .filter((l) => /^[0-9a-f]{64}$/.test(l))
);

if (!banned.size) {
  console.error('The deny-list has no entries. Refusing to report "clean" against an empty list.');
  process.exit(1);
}

/* ------------------------------------------------------------------ scanner */

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (TEXT.test(name)) out.push(full);
  }
  return out;
}

/**
 * Words, and adjacent word-pairs both spaced and joined. The pair forms are
 * what catch a two-word name however it is written, including the spelling
 * someone reaches for when they are trying to be discreet.
 */
function candidates(text) {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
  const out = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]);
    if (i + 1 < words.length) {
      out.push(words[i] + ' ' + words[i + 1]);
      out.push(words[i] + words[i + 1]);
    }
  }
  return out;
}

const authored = [];
let mirrorHits = 0;

for (const file of files(ROOT)) {
  const rel = relative(ROOT, file);
  let hits = 0;
  for (const c of candidates(readFileSync(file, 'utf8'))) {
    if (banned.has(hash(c))) hits++;
  }
  if (!hits) continue;
  if (rel === MIRROR) mirrorHits = hits;
  else authored.push({ file: rel, hits });
}

/* ------------------------------------------------------------------- report */

const overBaseline = mirrorHits > MIRROR_BASELINE;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ authored, mirrorHits, baseline: MIRROR_BASELINE, overBaseline }, null, 2));
  process.exit(authored.length || overBaseline ? 1 : 0);
}

if (authored.length) {
  console.error('LEAK — terms from outside this repo appear in files authored here:\n');
  /* The term is never printed. Naming it in CI output would publish it in a
     build log, which is the same failure by a slower route. */
  for (const a of authored) console.error(`  ${a.file}  — ${a.hits} match(es)`);
  console.error('\nRemove them. If you need to say what they refer to, say it in chat, not in a file.');
}

if (mirrorHits) {
  const verdict = overBaseline ? 'ABOVE BASELINE' : 'at baseline';
  console.error(`\n${MIRROR} carries ${mirrorHits} match(es) — ${verdict} of ${MIRROR_BASELINE}.`);
  console.error('That file is generated from the vault, so the fix is the vault note, not this repo.');
  if (overBaseline) console.error('The count grew. Something new leaked upstream.');
}

if (!authored.length && !overBaseline) {
  console.log(`Clean. ${banned.size} term(s) checked, no leak in authored files.`);
  if (mirrorHits) console.log(`${MIRROR} sits at its pinned baseline of ${MIRROR_BASELINE}, unchanged.`);
  process.exit(0);
}

process.exit(1);
