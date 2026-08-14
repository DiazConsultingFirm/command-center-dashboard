#!/usr/bin/env node
/**
 * The Scout's first real source.
 *
 * Reads the Command Center mirror (index.html, generated from the vault) and
 * writes data/jarvis-data.json for jarvis.html. Zero dependencies, read-only
 * against the mirror, and it never writes a number it did not read.
 *
 *   node agents/scout-vault.mjs            # write data/jarvis-data.json
 *   node agents/scout-vault.mjs --dry-run  # print what it found, write nothing
 *
 * The rules from agents/scout.md are enforced here, not just documented:
 *
 *   - A field it cannot parse is written as null with a PARSE FAILED source,
 *     so the screen shows UNAVAILABLE instead of a stale or invented figure.
 *   - asOf comes from the mirror's own timestamp, never from today's date, so
 *     a mirror that stopped updating reports its real age.
 *   - It never authors Advisor recommendations. Gathering and advising are
 *     different jobs, and this one only gathers.
 *   - A pipeline figure is only counted when the note states it explicitly.
 *     This is the mirror's own rule: an engagement with no agreed figure is
 *     left out of the totals rather than estimated into them.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(ROOT, 'index.html');
const OUT = join(ROOT, 'data', 'jarvis-data.json');
const DRY = process.argv.includes('--dry-run');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const notes = [];   /* audit trail printed at the end */

function decode(s) {
  return String(s)
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ')
    .trim();
}

const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

/** A parsed metric, or an explicit UNAVAILABLE when the mirror did not have it. */
function metric(value, label, asOf) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    notes.push(`  UNAVAILABLE  ${label}`);
    return { v: null, source: `PARSE FAILED — "${label}" not found in the Command Center mirror`, asOf: null };
  }
  notes.push(`  ok           ${label} = ${value}`);
  return { v: value, source: `Command Center mirror (index.html) — ${label}`, asOf };
}

/* ------------------------------------------------------------------ read */

if (!existsSync(MIRROR)) {
  console.error('No index.html found at ' + MIRROR + ' — nothing to read.');
  process.exit(1);
}
const html = readFileSync(MIRROR, 'utf8');

/* ------------------------------------------------- the mirror's own date */

let asOf = null;
const stampMatch = html.match(/<p class="sub">\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
if (stampMatch) {
  const mi = MONTHS.indexOf(stampMatch[1]);
  if (mi >= 0) asOf = `${stampMatch[3]}-${String(mi + 1).padStart(2, '0')}-${String(stampMatch[2]).padStart(2, '0')}`;
}
if (!asOf) {
  /* Without a date we cannot honestly stamp anything. Refuse rather than
     stamping today onto figures whose age we do not know. */
  console.error('Could not read the mirror timestamp. Refusing to write undated figures.');
  process.exit(1);
}
notes.push(`  ok           mirror timestamp = ${asOf}`);

/* --------------------------------------------------------------- counters */

/** KPI cards: <span class="kpi-label">X</span> ... <div class="kpi-value" ...>N</div> */
function kpi(label) {
  const re = new RegExp(`<span class="kpi-label">${label}</span>[\\s\\S]{0,400}?<div class="kpi-value"[^>]*>([\\d,]+)</div>`);
  const hit = html.match(re);
  return hit ? num(hit[1]) : null;
}

/** Sidebar counts: <span class="nav-label">X</span><span class="nav-count">N</span> */
function navCount(label) {
  const re = new RegExp(`<span class="nav-label">${label}</span><span class="nav-count">(\\d+)</span>`);
  const hit = html.match(re);
  return hit ? num(hit[1]) : null;
}

/** Pipeline snapshot: <span class="ps-label">X</span><span class="ps-val...">$N</span> */
function snapshot(label) {
  const re = new RegExp(`<span class="ps-label">${label}</span><span class="ps-val[^"]*">\\$([\\d,]+)</span>`);
  const hit = html.match(re);
  return hit ? num(hit[1]) : null;
}

/** Workload bars: <div class="bar-label">X</div>...<div class="bar-val">N</div> */
function workloadBar(label) {
  const re = new RegExp(`<div class="bar-label">[^<]*${label}</div>[\\s\\S]{0,300}?<div class="bar-val">(\\d+)</div>`);
  const hit = html.match(re);
  return hit ? num(hit[1]) : null;
}

const attention = kpi('Needs Attention');
const clients = kpi('Clients');
const projects = kpi('Projects');
const nextActions = navCount('Next Actions');
/* The sidebar carries no count for Parked when it is empty, so fall back to
   the workload bar — a second real source, not an assumed zero. */
const parked = navCount('Parked') ?? workloadBar('Parked');
const collected = snapshot('Collected');
const outstanding = snapshot('Outstanding');

/* --------------------------------------------------------------- pipeline */

/**
 * A figure counts only when the note states it. Three explicit shapes are
 * read; anything else keeps its text in `note` and stays out of the totals.
 */
function agreedFigure(noteText) {
  const recommended = noteText.match(/\$([\d,]+)\s*\(recommended\)/i);
  if (recommended) return { value: num(recommended[1]), rule: 'labelled (recommended)' };

  const received = noteText.match(/\$([\d,]+)\s*received/i);
  const owed = noteText.match(/\$([\d,]+)\s*owed/i);
  if (received && owed) return { value: num(received[1]) + num(owed[1]), rule: 'received + owed, both stated' };
  if (received && !/\$[\d,]+\s*\/\s*\$/.test(noteText)) return { value: num(received[1]), rule: 'single stated figure' };

  const all = noteText.match(/\$[\d,]+/g) || [];
  if (all.length === 1) return { value: num(all[0]), rule: 'single stated figure' };

  return { value: null, rule: 'ambiguous — left out of totals' };
}

const pipelineItems = [];
for (const chunk of html.split('<div class="pipeline-item">').slice(1)) {
  const name = chunk.match(/<h4>([^<]+)<\/h4>/);
  const stage = chunk.match(/<span class="pill [^"]*">([^<]+)<\/span>/);
  const figure = chunk.match(/<p class="pipeline-figure">([^<]+)<\/p>/);
  if (!name) continue;
  const noteText = figure ? decode(figure[1]) : '';
  const agreed = agreedFigure(noteText);
  pipelineItems.push({
    name: decode(name[1]).toUpperCase(),
    stage: stage ? decode(stage[1]).toUpperCase() : 'UNKNOWN',
    value: agreed.value,
    note: noteText.toUpperCase()
  });
  notes.push(`  ok           pipeline: ${decode(name[1])} — ${agreed.value === null ? 'no agreed figure' : '$' + agreed.value} (${agreed.rule})`);
}

/* ------------------------------------------------- proximity from attention */

/**
 * The four most urgent Attention items become radar contacts. Distance is
 * driven by idle days — the longer something has sat, the closer it is to
 * you — and anything blocked is flagged regardless of age.
 */
const attentionBlock = html.slice(
  html.indexOf('id="attention"'),
  html.indexOf('id="next-actions"') > 0 ? html.indexOf('id="next-actions"') : undefined
);
const contacts = [];
const cardRe = /<h4>([^<]+)<\/h4>\s*<p class="rc-meta">([^<]*)<\/p>/g;
let card;
while ((card = cardRe.exec(attentionBlock)) && contacts.length < 4) {
  const label = decode(card[1]).toUpperCase();
  const meta = decode(card[2]);
  const idle = meta.match(/(\d+)d idle/);
  const idleDays = idle ? num(idle[1]) : 0;
  const blocked = /^blocked/i.test(meta);
  contacts.push({
    label: label.length > 22 ? label.slice(0, 21) + '…' : label,
    /* 30 idle days or more sits right on top of you; fresh sits at the edge. */
    distance: Math.max(0.1, Math.min(0.92, 1 - idleDays / 30)),
    level: blocked ? 'bad' : idleDays >= 14 ? 'warn' : 'ok'
  });
}
notes.push(`  ok           proximity contacts = ${contacts.length}`);

/* ------------------------------------------------------- status vs. pace */

/**
 * Honest derivation, labelled as a derivation rather than a read figure.
 * Refuses to judge pace against a placeholder target: "well behind" is a
 * verdict, and a verdict built on an invented number is worse than none.
 */
function paceStatus(current, target, targetIsReal) {
  if (current === null || !target || !targetIsReal) return null;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const expected = (now.getDate() / daysInMonth) * target;
  if (current >= target) return 'TARGET MET';
  if (current >= expected) return 'ON TRACK';
  if (current >= expected * 0.7) return 'BEHIND PACE';
  return 'WELL BEHIND';
}

/* -------------------------------------------- preserve human-set decisions */

let previous = {};
if (existsSync(OUT)) {
  try { previous = JSON.parse(readFileSync(OUT, 'utf8')); } catch { previous = {}; }
}
/* A target is a decision, not a data source — never overwrite one you set. */
const target = previous?.objective?.target?.v ?? 10000;
const targetSource = previous?.objective?.target?.source ?? 'PLACEHOLDER: set your real monthly target';
const targetIsReal = !/^PLACEHOLDER/i.test(targetSource);
/* Same for the objective line: it is yours to write. */
const meta = previous.meta ?? undefined;

/* ------------------------------------------------------------------ write */

/* Build each metric once — the same figure feeds both the objective card and
   the revenue section, and reading it twice just doubles the audit log. */
const collectedMetric = metric(collected, 'pipeline snapshot: Collected', asOf);

const out = {
  _generatedBy: 'agents/scout-vault.mjs — read from the Command Center mirror. Do not hand-edit; rerun the Scout instead.',
  ...(meta ? { meta } : {}),

  objective: {
    label: 'REVENUE COLLECTED — TO DATE',
    currentLabel: 'COLLECTED',
    unit: 'USD',
    target: { v: target, source: targetSource, asOf },
    current: collectedMetric,
    status: paceStatus(collected, target, targetIsReal)
      ? { v: paceStatus(collected, target, targetIsReal), source: 'derived: collected vs. pace of the month', asOf }
      : targetIsReal
        ? { v: null, source: 'PARSE FAILED — no collected figure to derive status from', asOf: null }
        : { v: 'NO TARGET SET', source: 'target is a placeholder — set a real one to get a pace status', asOf },
    eta: { v: 'END OF MONTH', source: 'billing month boundary', asOf }
  },

  revenue: {
    collectedMTD: collectedMetric,
    outstanding: metric(outstanding, 'pipeline snapshot: Outstanding', asOf),
    /* No payment processor is connected, so these stay honestly empty. */
    yesterday: { v: null, source: 'NOT WIRED — needs a payment processor connector', asOf: null },
    lastMonth: { v: null, source: 'NOT WIRED — needs a payment processor connector', asOf: null }
  },

  book: {
    attention: metric(attention, 'KPI: Needs Attention', asOf),
    nextActions: metric(nextActions, 'sidebar count: Next Actions', asOf),
    clients: metric(clients, 'KPI: Clients', asOf),
    projects: metric(projects, 'KPI: Projects', asOf),
    parked: metric(parked, 'sidebar count: Parked', asOf)
  },

  pipeline: {
    asOf,
    source: 'Command Center mirror (index.html) — pipeline panel',
    items: pipelineItems
  },

  proximity: { asOf, contacts },

  /* Deliberately empty: gathering and advising are different jobs, and this
     script only gathers. The screen will say the Advisor has not run rather
     than reading invented recommendations aloud. */
  advisor: { asOf, recommendations: [], unactioned: [] }
};

console.log(`Scout — read ${MIRROR.replace(ROOT + '/', '')}, mirror dated ${asOf}\n`);
console.log(notes.join('\n'));

const unavailable = notes.filter((n) => n.includes('UNAVAILABLE')).length;
console.log(`\n${unavailable === 0 ? 'Every field read cleanly.' : unavailable + ' field(s) could not be read and were written as UNAVAILABLE.'}`);

if (DRY) {
  console.log('\n--dry-run: nothing written.');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${OUT.replace(ROOT + '/', '')} — 7 of 8 sections live (operator still mock).`);
}
