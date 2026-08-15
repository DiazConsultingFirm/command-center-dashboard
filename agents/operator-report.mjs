#!/usr/bin/env node
/**
 * The Operator's writer — the only thing that may write the `operator` section
 * of data/jarvis-data.json.
 *
 *   node agents/operator-report.mjs --resolved 3 --drafted 2 --escalated 1 --published 0
 *   node agents/operator-report.mjs --escalated 4 --dry-run
 *   echo '{"resolved":3,"escalated":1}' | node agents/operator-report.mjs
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN AN AGENT EDITING JSON
 *
 * 1. ENCODING. Everything that writes data/jarvis-data.json goes through
 *    agents/lib/data-file.mjs, because a Node writer and a hand-written Python
 *    writer produce different bytes for the same content (`—` vs `—`).
 *    That produces commits that claim the numbers moved when only the encoding
 *    did. One writer, one encoding, and a diff means a real change.
 *
 * 2. NULL IS NOT ZERO. This is the rule the whole script exists to enforce.
 *    A count that was not supplied is written as null, which the dashboard
 *    renders as UNAVAILABLE in amber and which the assistant refuses to read
 *    aloud. It is never defaulted to 0. "The Operator escalated nothing today"
 *    and "nobody counted what the Operator escalated" are different facts, and
 *    a screen that shows the second as the first is a screen that quietly
 *    lies — the exact failure the whole `{v, source, asOf}` contract exists to
 *    prevent. An agent free-handing this JSON writes `0` without thinking; a
 *    flag you did not pass cannot become a zero.
 *
 * 3. VALIDATION. Counts are non-negative integers or the run is refused. A
 *    "3 emails" or a "-1" reaching the data file means the panel shows
 *    nonsense, and the Scout will faithfully carry that nonsense forward on
 *    every future run because the Scout passes this section through untouched.
 *
 * Writes nothing but the `operator` section. It cannot touch the Advisor's
 * recommendations or the Scout's figures, by construction.
 */

import { readData, writeSection, serialize, today, DATA_PATH } from './lib/data-file.mjs';
import { existsSync } from 'node:fs';

/** The four counts the dashboard's Operator panel reads, in display order. */
const FIELDS = ['resolved', 'drafted', 'escalated', 'published'];

const SOURCE_MEASURED = 'Operator run log — reported via agents/operator-report.mjs';
const sourceMissing = (name) =>
  `NOT MEASURED — this run did not report a ${name} count (which is not the same as zero)`;

/* --------------------------------------------------------------- arguments */

function usage() {
  console.log(`Operator report — writes the operator section of data/jarvis-data.json

  node agents/operator-report.mjs --resolved 3 --drafted 2 --escalated 1 --published 0
  node agents/operator-report.mjs --escalated 4 --dry-run
  echo '{"resolved":3,"escalated":1}' | node agents/operator-report.mjs

Flags:
  --resolved N   answered from faq.md without Evans
  --drafted N    drafted and left for Evans to send
  --escalated N  handed to Evans with a reason
  --published N  content published after written approval
  --as-of DATE   ISO date for the run (defaults to today)
  --dry-run      print the section and the diff, write nothing
  --help

Any count you do not pass is written as null and shows as UNAVAILABLE on the
screen. That is deliberate: not measuring something is not the same as it
being zero, and the dashboard must never conflate the two.`);
}

/** Parse --flag value pairs. Unknown flags are an error, not a shrug: a typo'd
 *  --escalted would otherwise silently report "we escalated nothing today". */
function parseArgs(argv) {
  const out = { counts: {}, dryRun: false, asOf: null };
  const known = new Set([...FIELDS.map((f) => `--${f}`), '--as-of', '--dry-run', '--help', '-h']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!known.has(arg)) throw new Error(`Unknown flag "${arg}". Run with --help.`);
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value.`);
    if (arg === '--as-of') { out.asOf = value; continue; }
    out.counts[arg.slice(2)] = value;
  }
  return out;
}

/**
 * A count is a non-negative integer or it is refused.
 *
 * Refused rather than coerced: Number('') is 0 and Number('3 emails') is NaN,
 * and both of those silently becoming a figure on a dashboard is worse than a
 * loud failure that costs one rerun.
 */
function validateCount(name, raw) {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (String(raw).trim() === '' || Number.isNaN(value)) {
    throw new Error(`--${name} "${raw}" is not a number. Counts must be plain non-negative integers.`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} ${raw} is not a whole number. You cannot half-escalate an email.`);
  }
  if (value < 0) {
    throw new Error(`--${name} ${raw} is negative. If you did not measure it, leave the flag off and it is written as null.`);
  }
  return value;
}

/** ISO date, so a run cannot be stamped "yesterday-ish". */
function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--as-of "${value}" is not an ISO date (YYYY-MM-DD).`);
  return value;
}

async function readStdin() {
  /* Only read stdin when something is actually piped in. An interactive
     terminal would otherwise hang here looking like a crash. */
  if (process.stdin.isTTY) return null;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  text = text.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object like {"resolved":3}');
    }
    return parsed;
  } catch (err) {
    throw new Error(`stdin is not a JSON object of counts (${err.message}).`);
  }
}

/* -------------------------------------------------------------------- main */

/* Every validation failure below is a refusal to write, printed as one plain
   line. A stack trace here would bury the one sentence that matters. */
process.on('uncaughtException', (err) => {
  console.error(`Refused to write: ${err.message}`);
  process.exit(1);
});

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }

const piped = await readStdin();
/* CLI flags win over stdin, so a scripted pipeline can still be overridden by
   hand on one field without rewriting the JSON it pipes in. */
const supplied = { ...(piped ?? {}) , ...args.counts };

for (const key of Object.keys(supplied)) {
  if (!FIELDS.includes(key)) throw new Error(`"${key}" is not an Operator count. Valid: ${FIELDS.join(', ')}`);
}

const asOf = args.asOf ? validateDate(args.asOf) : today();

const section = { asOf };
const measured = [];
for (const name of FIELDS) {
  if (Object.prototype.hasOwnProperty.call(supplied, name)) {
    const v = validateCount(name, supplied[name]);
    section[name] = { v, source: SOURCE_MEASURED, asOf };
    measured.push(name);
  } else {
    /* Not supplied → null, never 0. See the header. */
    section[name] = { v: null, source: sourceMissing(name), asOf: null };
  }
}

/* ------------------------------------------------------------------ report */

if (!existsSync(DATA_PATH)) {
  console.warn('Note: data/jarvis-data.json does not exist yet. Run agents/scout-vault.mjs first,');
  console.warn('or this file will hold the operator section and nothing else, and the rest of the');
  console.warn('screen will stay on mock data.\n');
}

const before = readData().operator ?? null;

console.log(`Operator report — run of ${asOf}\n`);
for (const name of FIELDS) {
  const prev = before?.[name]?.v;
  const next = section[name].v;
  const shown = next === null ? 'UNAVAILABLE (null — not measured)' : String(next);
  const was = before === null ? 'no previous run' : prev === null || prev === undefined ? 'UNAVAILABLE' : String(prev);
  const flag = measured.includes(name) ? 'reported ' : 'NOT GIVEN';
  console.log(`  ${flag}  ${name.padEnd(9)} ${was} → ${shown}`);
}

const missing = FIELDS.filter((f) => !measured.includes(f));
console.log('');
if (measured.length === 0) {
  console.log('Nothing was reported. Every count writes as UNAVAILABLE, which is honest but useless —');
  console.log('pass at least one flag, e.g. --escalated 4.');
} else if (missing.length) {
  console.log(`${missing.join(', ')} left as UNAVAILABLE — the screen will show amber there rather than a zero you did not measure.`);
} else {
  console.log('All four counts reported.');
}

if (args.dryRun) {
  console.log('\n--dry-run: nothing written. This is what would go in:\n');
  console.log(serialize({ operator: section }).trimEnd());
  process.exit(0);
}

const { changed } = writeSection('operator', section);
console.log(
  changed
    ? '\nWrote the operator section of data/jarvis-data.json. The Operator panel is now live.'
    : '\nNo change — the file already said exactly this. Nothing written, so no empty commit.'
);
