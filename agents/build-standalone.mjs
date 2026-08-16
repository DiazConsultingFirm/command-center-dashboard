#!/usr/bin/env node
/**
 * Bake jarvis.html + data/jarvis-data.json into ONE self-contained file.
 *
 *   node agents/build-standalone.mjs                 # -> build/jarvis-standalone.html
 *   node agents/build-standalone.mjs --out PATH      # somewhere else
 *
 * WHY THIS EXISTS
 *
 * jarvis.html fetches its numbers from a sibling JSON file at runtime. That is
 * the right design for the repo: the Scout rewrites the JSON, the page picks it
 * up, and neither has to know about the other. It is the wrong design the
 * moment the page is opened anywhere that file does not sit beside it — a
 * hosted page, an emailed copy, a double-clicked file:// URL. The fetch fails,
 * the page falls back to its mock object, and the DATA badge honestly reports
 * MOCK. Honest, and useless.
 *
 * So this produces a copy with today's figures already inside it. One file, no
 * server, no build tooling, opens anywhere.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not touch jarvis.html. The source of truth stays the fetching
 * version; this is a snapshot taken from it. A snapshot is frozen by
 * definition — it shows the numbers as of the moment it was built — so the
 * build injects a SNAPSHOT pill into the header carrying that date. Without it
 * the page is indistinguishable from the live one, and a stale figure wearing a
 * live badge is the single failure this whole system exists to prevent.
 *
 * It also fails loudly rather than silently. If jarvis.html's loader is ever
 * rewritten, the string surgery below stops matching and this script exits
 * non-zero instead of emitting a file that quietly shows mock data under a LIVE
 * badge.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'jarvis.html');
const DATA = join(ROOT, 'data', 'jarvis-data.json');

const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : join(ROOT, 'build', 'jarvis-standalone.html');

/* ----------------------------------------------------------------- inputs */

for (const [label, path] of [['jarvis.html', PAGE], ['data/jarvis-data.json', DATA]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${label} at ${path}. Run the Scout first: node agents/scout-vault.mjs`);
    process.exit(1);
  }
}

const html = readFileSync(PAGE, 'utf8');
const raw = readFileSync(DATA, 'utf8');

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`data/jarvis-data.json is not valid JSON (${err.message}). Refusing to build.`);
  process.exit(1);
}

/* ------------------------------------------------------------- the surgery */

/* Matched against jarvis.html verbatim. If the loader changes shape, this stops
   matching and the build fails, which is the intended outcome: better a broken
   build than a standalone file showing mock numbers under a LIVE badge. */
const FETCH_BLOCK = `    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const live = await res.json();`;

if (!html.includes(FETCH_BLOCK)) {
  console.error('Could not find the fetch block in jarvis.html — its loader has changed.');
  console.error('Update FETCH_BLOCK in this script to match, then rebuild.');
  console.error('Refusing to emit a file that would silently fall back to mock data.');
  process.exit(1);
}

const ANCHOR = "const DATA_URL = 'data/jarvis-data.json';";
if (!html.includes(ANCHOR)) {
  console.error(`Could not find "${ANCHOR}" in jarvis.html. Refusing to build.`);
  process.exit(1);
}

/* `</script>` inside a JSON string would end the surrounding script tag early
   and break the page. Nothing in the data should contain it, but the cost of
   being wrong is a blank screen, so it is escaped rather than trusted. */
const inline = JSON.stringify(data, null, 2).replace(/<\//g, '<\\/');

/* The header pill that marks this copy as frozen. Styled with the page's own
   `pill mock` class — the amber one it already uses for "these numbers are not
   what you think" — so it reads as part of the instrument rather than a sticker
   on top of it. */
const PILLS_ANCHOR = '      <div class="pills">';
if (!html.includes(PILLS_ANCHOR)) {
  console.error('Could not find the header pills container in jarvis.html. Refusing to build,');
  console.error('because an unlabelled snapshot is indistinguishable from the live page.');
  process.exit(1);
}

const builtAt = new Date().toISOString().slice(0, 10);
const snapshotPill =
  `${PILLS_ANCHOR}\n` +
  `        <span class="pill mock" title="A frozen copy built by agents/build-standalone.mjs. ` +
  `These figures do not refresh — the live screen is jarvis.html.">` +
  `<span class="dot"></span>SNAPSHOT · ${builtAt}</span>`;

const built = html
  .replace(ANCHOR, `${ANCHOR}\n\n/* Baked in by agents/build-standalone.mjs — see the SNAPSHOT pill in the header. */\nconst INLINE_DATA = ${inline};`)
  .replace(FETCH_BLOCK, '    const live = INLINE_DATA;')
  .replace(PILLS_ANCHOR, snapshotPill);

if (built === html) {
  console.error('Nothing was substituted. Refusing to emit an unchanged copy.');
  process.exit(1);
}

/* ------------------------------------------------------------------ output */

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, built);

const asOf = data?.meta?.asOf || data?.objective?.current?.asOf || 'unknown';
const sections = ['meta', 'objective', 'revenue', 'book', 'pipeline', 'operator', 'advisor', 'proximity']
  .filter((k) => k in data);

console.log(`Wrote ${OUT.replace(ROOT + '/', '')}`);
console.log(`  ${sections.length} section(s) baked in: ${sections.join(', ')}`);
console.log(`  advisor brief asOf ${data?.advisor?.asOf ?? 'not run'}`);
console.log(`  figures as of      ${asOf}`);
console.log('');
console.log('This file is a SNAPSHOT. It does not refresh. Rebuild it after the');
console.log('Scout runs, or the numbers in it drift away from the vault silently.');
