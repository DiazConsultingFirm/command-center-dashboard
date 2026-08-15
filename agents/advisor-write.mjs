#!/usr/bin/env node
/**
 * The Advisor's write path.
 *
 * The Advisor is a reasoning agent, so it produces prose, not bytes. Left to
 * hand-write data/jarvis-data.json it produces bytes anyway — and they are the
 * wrong ones. Written from Python, `—` is escaped to `—`; the Scout
 * writes the same character raw from Node. The content is identical, the file
 * is not, and the next Scout run commits an 18-line diff that claims the
 * numbers were refreshed when nothing moved (that is commit 401b1a7). Left
 * alone it happens every day and the history stops telling you when the
 * figures actually changed.
 *
 * So the Advisor stops writing JSON and starts handing it to this script,
 * which is the only thing that touches the advisor section:
 *
 *   cat advisor.json | node agents/advisor-write.mjs      # publish
 *   node agents/advisor-write.mjs --file advisor.json     # same, from a path
 *   node agents/advisor-write.mjs --file x.json --dry-run # validate only
 *   node agents/advisor-write.mjs --check                 # lint what is live
 *
 * Two jobs, and the second matters as much as the first:
 *
 *   1. ENCODING. Everything goes through agents/lib/data-file.mjs, so there is
 *      exactly one writer and one canonical form. A diff means a real change.
 *   2. THE CONTRACT. agents/advisor.md is prose, and prose is advisory until
 *      something enforces it. The rules that make the morning brief worth
 *      reading — exactly three recommendations, every one carrying evidence
 *      and a cost, nothing padded, nothing stamped tomorrow — are checked here
 *      mechanically, before anything reaches the screen. A brief that fails
 *      the contract does not get published half-written; it gets rejected with
 *      the reason, and yesterday's advice stays up until the Advisor fixes it.
 *
 * Zero dependencies. Node 22.
 */

import { readFileSync } from 'node:fs';
import { readData, writeSection, serialize, today, DATA_PATH, ROOT } from './lib/data-file.mjs';

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY = has('--dry-run');
const CHECK = has('--check');
const FILE = valueOf('--file');
const rel = (p) => p.replace(ROOT + '/', '');

if (has('--help') || has('-h')) {
  console.log(`Publish the Advisor's brief into ${rel(DATA_PATH)}.

  cat advisor.json | node agents/advisor-write.mjs
  node agents/advisor-write.mjs --file advisor.json
  node agents/advisor-write.mjs --file advisor.json --dry-run
  node agents/advisor-write.mjs --check

  --file <path>  read the payload from a file instead of stdin
  --dry-run      validate and report what would change; write nothing
  --check        validate the advisor section already in the data file

Payload shape (see agents/advisor.md):
  { "asOf": "YYYY-MM-DD",
    "recommendations": [ { "action": "...", "evidence": "...", "cost": "..." } ],
    "unactioned": [ "..." ] }`);
  process.exit(0);
}

if (has('--file') && (FILE === undefined || FILE.startsWith('--'))) {
  /* `--file --dry-run` would otherwise try to open a flag as a filename. */
  fail(['--file needs a path, e.g. --file advisor.json']);
}

/* --------------------------------------------------------------- failures */

/**
 * Every rejection prints every problem it found, not just the first. An agent
 * that has to rerun once per error burns a turn per typo; one that gets the
 * whole list fixes the payload in a single pass.
 */
function fail(problems, hint) {
  console.error(`REJECTED — the brief does not meet the contract in agents/advisor.md:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  if (hint) console.error(`\n${hint}`);
  console.error(
    CHECK
      ? `\nNothing was written — --check only reads. Republish a corrected brief through this script.`
      : `\nNothing was written. The previous advisor section is untouched.`
  );
  process.exit(1);
}

/* ------------------------------------------------------------ the contract */

/** Keys the dashboard reads. Anything else is a typo until the contract says otherwise. */
const SECTION_KEYS = ['asOf', 'recommendations', 'unactioned'];
const REC_KEYS = ['action', 'evidence', 'cost'];

/**
 * advisor.md asks for "exactly three". Three is the ceiling, not the floor:
 * fewer is explicitly correct when the day is routine, and the prompt warns
 * that "a padded third recommendation trains me to stop reading all three".
 * So the only count this can mechanically reject is too many — a fourth means
 * the ranking was never forced to make a decision.
 */
const MAX_RECOMMENDATIONS = 3;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** A string that carries something. `"   "` is an empty field wearing a disguise. */
const isFilled = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * A real calendar date in ISO form. The round-trip catches 2026-02-30, which
 * matches the pattern and is not a day.
 */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Returns a list of problems — empty means the payload is publishable.
 *
 * `where` names the thing being validated so --check can say "the advisor
 * section in data/jarvis-data.json" while a publish says "the payload".
 */
function validate(section, where) {
  const problems = [];

  if (!isPlainObject(section)) {
    return [`${where} must be a JSON object with asOf, recommendations and unactioned — got ${typeName(section)}.`];
  }

  const unknown = Object.keys(section).filter((k) => !SECTION_KEYS.includes(k));
  if (unknown.length) {
    /* Almost always a misspelling. Silently dropping it would publish a brief
       missing the field the Advisor thought it wrote. */
    problems.push(`${where} has unexpected key(s): ${unknown.join(', ')}. Expected only ${SECTION_KEYS.join(', ')}.`);
  }

  /* ------------------------------------------------------------- asOf */

  if (!('asOf' in section)) {
    problems.push(`asOf is missing. Every brief carries the date of the data it was reasoned from (e.g. "${today()}").`);
  } else if (typeof section.asOf !== 'string') {
    problems.push(`asOf must be a string in YYYY-MM-DD form — got ${typeName(section.asOf)}.`);
  } else if (!isRealDate(section.asOf)) {
    problems.push(`asOf "${section.asOf}" is not a real date in YYYY-MM-DD form.`);
  } else if (section.asOf > today()) {
    /* ISO dates sort lexicographically, so a plain string compare is the whole
       check. A brief cannot be stamped tomorrow: the screen speaks that date
       aloud as the age of the advice, and advice from the future is advice
       nobody can date. Usually a clock or a hardcoded string, not a judgement. */
    problems.push(`asOf "${section.asOf}" is in the future (today is ${today()}). A brief cannot be stamped later than the data it read.`);
  }

  /* --------------------------------------------------- recommendations */

  if (!('recommendations' in section)) {
    problems.push(`recommendations is missing. Pass [] to publish an empty brief — that is how the screen says the day looks routine.`);
  } else if (!Array.isArray(section.recommendations)) {
    problems.push(`recommendations must be an array — got ${typeName(section.recommendations)}.`);
  } else {
    if (section.recommendations.length > MAX_RECOMMENDATIONS) {
      problems.push(
        `${section.recommendations.length} recommendations — the contract is at most ${MAX_RECOMMENDATIONS}. ` +
        `If more than three things look urgent, that is a ranking that has not been done yet, not a longer list.`
      );
    }
    section.recommendations.forEach((rec, i) => {
      const at = `recommendations[${i}]`;
      if (!isPlainObject(rec)) {
        problems.push(`${at} must be an object with ${REC_KEYS.join(', ')} — got ${typeName(rec)}.`);
        return;
      }
      for (const key of REC_KEYS) {
        if (!(key in rec)) problems.push(`${at}.${key} is missing.`);
        else if (typeof rec[key] !== 'string') problems.push(`${at}.${key} must be a string — got ${typeName(rec[key])}.`);
        else if (!isFilled(rec[key])) problems.push(`${at}.${key} is empty.`);
      }
      const strayKeys = Object.keys(rec).filter((k) => !REC_KEYS.includes(k));
      if (strayKeys.length) {
        problems.push(`${at} has unexpected key(s): ${strayKeys.join(', ')}. Expected only ${REC_KEYS.join(', ')}.`);
      }
    });
  }

  /* -------------------------------------------------------- unactioned */

  if (!('unactioned' in section)) {
    /* advisor.md: this list is "the difference between a briefing and a system
       that improves". Missing it is not the same as having nothing to carry
       forward, so it is not defaulted — pass [] and mean it. */
    problems.push(`unactioned is missing. Pass [] when nothing from the last 7 days is outstanding.`);
  } else if (!Array.isArray(section.unactioned)) {
    problems.push(`unactioned must be an array of strings — got ${typeName(section.unactioned)}.`);
  } else {
    section.unactioned.forEach((item, i) => {
      if (typeof item !== 'string') problems.push(`unactioned[${i}] must be a string — got ${typeName(item)}.`);
      else if (!isFilled(item)) problems.push(`unactioned[${i}] is empty.`);
    });
  }

  return problems;
}

/**
 * Rebuild the section with a fixed key order and trimmed strings.
 *
 * Key order is the other half of the phantom-diff bug: the same three fields
 * emitted in a different order produce a diff that reviews as a rewrite. One
 * writer means one order too.
 */
function canonical(section) {
  return {
    asOf: section.asOf,
    recommendations: section.recommendations.map((r) => ({
      action: r.action.trim(),
      evidence: r.evidence.trim(),
      cost: r.cost.trim()
    })),
    unactioned: section.unactioned.map((s) => s.trim())
  };
}

/* -------------------------------------------------------------- summaries */

/** First sentence of an action, for the "what did I just publish" readback. */
function firstLine(text) {
  const line = text.trim().split('\n')[0];
  const sentence = line.match(/^.*?[.!?](?=\s|$)/);
  const out = (sentence ? sentence[0] : line).trim();
  return out.length > 96 ? out.slice(0, 95) + '…' : out;
}

function summarize(section, headline) {
  const n = section.recommendations.length;
  console.log(`${headline}`);
  console.log(`  asOf            ${section.asOf}${section.asOf === today() ? '' : `  (today is ${today()})`}`);
  console.log(`  recommendations ${n}${n === 0 ? '  — an empty brief: the screen will say the Advisor has not run' : ''}`);
  section.recommendations.forEach((r, i) => console.log(`    ${i + 1}. ${firstLine(r.action)}`));
  console.log(`  unactioned      ${section.unactioned.length}`);
}

/* ------------------------------------------------------------ --check mode */

if (CHECK) {
  /* A lint step, so it reads what is live and writes nothing. Use it in CI or
     before a commit to catch a section that was hand-edited back into a shape
     the screen cannot speak. */
  const data = readData();
  if (!('advisor' in data)) {
    console.error(`No advisor section in ${rel(DATA_PATH)}. Run the Scout, or publish a brief with this script.`);
    process.exit(1);
  }
  const problems = validate(data.advisor, `the advisor section in ${rel(DATA_PATH)}`);
  if (problems.length) fail(problems);

  /* Encoding is part of the contract too: if rewriting the section canonically
     would change the file, the bytes on disk are not the ones this path
     produces, and the next writer will emit a diff that is pure noise. */
  const wouldRewrite = serialize({ ...data, advisor: canonical(data.advisor) }) !== serialize(data);
  summarize(data.advisor, `OK — the advisor section in ${rel(DATA_PATH)} meets the contract.`);
  if (wouldRewrite) {
    console.log(`\nNote: the section is valid but not in canonical form (key order or whitespace).`);
    console.log(`Republishing it through this script would normalise it and remove a phantom diff later.`);
  }
  process.exit(0);
}

/* -------------------------------------------------------------- the input */

async function readStdin() {
  /* No pipe and no --file is the commonest mistake — the process would
     otherwise hang forever on an interactive terminal with no explanation. */
  if (process.stdin.isTTY) {
    console.error(`Nothing on stdin. Pipe the brief in, or pass a path:\n`);
    console.error(`  cat advisor.json | node agents/advisor-write.mjs`);
    console.error(`  node agents/advisor-write.mjs --file advisor.json`);
    console.error(`\nRun with --help for the payload shape, or --check to lint what is already live.`);
    process.exit(1);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** A missing --file is an operator typo, not a crash. Say which path failed. */
function readPayloadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Could not read --file ${path}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
    process.exit(1);
  }
}

const raw = FILE ? readPayloadFile(FILE) : await readStdin();

if (!raw.trim()) {
  fail([`The payload is empty.`], `An empty file is not an empty brief. To publish one, send {"asOf":"${today()}","recommendations":[],"unactioned":[]}.`);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (err) {
  fail([`The payload is not valid JSON: ${err.message}`], `Check for a trailing comma or an unquoted key. The payload is read as UTF-8; write "—" directly rather than escaping it.`);
}

/**
 * Accept both the bare section and a whole-file shape, because both are
 * natural things for the Advisor to hand over and guessing wrong costs a turn.
 * The wrapper is only unwrapped when the top level clearly is not the section.
 */
if (isPlainObject(payload) && isPlainObject(payload.advisor) && !('recommendations' in payload)) {
  payload = payload.advisor;
}

/* ---------------------------------------------------------------- publish */

const problems = validate(payload, 'the payload');
if (problems.length) fail(problems);

const section = canonical(payload);
const current = readData().advisor;
const identical = JSON.stringify(current) === JSON.stringify(section);

if (DRY) {
  summarize(section, `--dry-run — valid. This is what would be written:`);
  console.log(
    identical
      ? `\nNo change: ${rel(DATA_PATH)} already holds exactly this. A real run would write nothing.`
      : `\nWould update the advisor section of ${rel(DATA_PATH)}. Nothing written.`
  );
  process.exit(0);
}

const { changed } = writeSection('advisor', section);

summarize(section, changed ? `Published to ${rel(DATA_PATH)}:` : `Validated — already live in ${rel(DATA_PATH)}:`);
console.log(
  changed
    ? `\nFile changed. Commit ${rel(DATA_PATH)}.`
    : `\nNo change — the file already held exactly this brief. Skip the commit; there is nothing to record.`
);
