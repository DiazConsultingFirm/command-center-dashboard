#!/usr/bin/env node
/**
 * The whole system, tested in one command.
 *
 *   node test/smoke.mjs          # everything
 *   node test/smoke.mjs --cli    # just the agent tools (no browser needed)
 *
 * Exits non-zero if anything fails, so it works as a pre-commit or CI gate.
 *
 * Two things it deliberately does NOT do:
 *   - touch a real mailbox, or send anything anywhere
 *   - leave data/jarvis-data.json modified; every test that writes restores it
 *
 * The Kokoro tests run against test/fixtures/kokoro-mock.mjs rather than the
 * real library. That proves our half — export detection, progress, voice
 * substitution, every result shape, and the fallback — not that kokoro-js
 * itself works. Only a human hearing it prove that, once.
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ONLY = process.argv.includes('--cli');
const PORT = 8131;
const MOCK_PORT = 8132;

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: String(err.message || err).split('\n')[0].slice(0, 120) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: String(err.message || err).split('\n')[0].slice(0, 120) });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** Run a repo script, returning { code, out }. Never throws on non-zero. */
function run(args, input) {
  try {
    const out = execFileSync('node', args, {
      cwd: ROOT, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status === undefined ? 1 : err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const DATA = join(ROOT, 'data', 'jarvis-data.json');
const snapshot = existsSync(DATA) ? readFileSync(DATA, 'utf8') : null;
const dataNow = () => (existsSync(DATA) ? readFileSync(DATA, 'utf8') : null);

/* Restore what was actually there when the suite started — NOT what is in
   git. An earlier version used `git checkout`, which reset the file to HEAD
   and so silently destroyed any legitimate uncommitted change while also
   false-failing the no-churn test. A test harness that eats real work is
   worse than one that fails. */
function restoreData() {
  if (snapshot === null) return;
  if (dataNow() !== snapshot) writeFileSync(DATA, snapshot);
}

/* ======================================================== the agent tools == */

console.log('\nAGENT TOOLS\n');

check('scout: reads the mirror cleanly', () => {
  const r = run(['agents/scout-vault.mjs', '--dry-run']);
  assert(r.code === 0, `exit ${r.code}`);
  assert(/Every field read cleanly|UNAVAILABLE/.test(r.out), 'no audit output');
  assert(/mirror timestamp/.test(r.out), 'no timestamp read');
  return r.out.match(/mirror dated (\S+)/)?.[1] || '';
});

check('scout: no churn — a rerun changes nothing', () => {
  /* Settle first, then compare two consecutive runs. Comparing against git
     would conflate "the Scout is unstable" with "someone has uncommitted
     work", which are completely different problems. */
  run(['agents/scout-vault.mjs']);
  const settled = dataNow();
  run(['agents/scout-vault.mjs']);
  const rerun = dataNow();
  restoreData();
  assert(settled === rerun, 'a second Scout run produced different bytes');
  return 'byte-identical across runs';
});

check('scout: overrides apply and are labelled, not disguised', () => {
  if (!existsSync(join(ROOT, 'data', 'overrides.json'))) return 'no overrides active — skipped';
  run(['agents/scout-vault.mjs']);
  const d = JSON.parse(readFileSync(DATA, 'utf8'));
  const src = d.revenue.outstanding.source;
  restoreData();
  assert(/reported by/i.test(src), `override not attributed: ${src}`);
  assert(!/Command Center mirror/.test(src), 'override is impersonating a mirror figure');
  return 'attributed to a human';
});

check('advisor-write: the live brief meets its own contract', () => {
  const r = run(['agents/advisor-write.mjs', '--check']);
  assert(r.code === 0, `--check failed: ${r.out}`);
  return 'valid';
});

const BAD_BRIEFS = [
  ['four recommendations', { asOf: '2026-08-15', unactioned: [], recommendations: Array.from({ length: 4 }, () => ({ action: 'a', evidence: 'b', cost: 'c' })) }],
  ['empty evidence', { asOf: '2026-08-15', unactioned: [], recommendations: [{ action: 'a', evidence: '   ', cost: 'c' }] }],
  ['missing cost', { asOf: '2026-08-15', unactioned: [], recommendations: [{ action: 'a', evidence: 'b' }] }],
  ['future date', { asOf: '2099-01-01', unactioned: [], recommendations: [] }],
  ['impossible date', { asOf: '2026-02-30', unactioned: [], recommendations: [] }],
  ['unactioned not an array', { asOf: '2026-08-15', unactioned: 'nope', recommendations: [] }],
  ['misspelled key', { asOf: '2026-08-15', unactioned: [], recommendations: [{ actoin: 'a', evidence: 'b', cost: 'c' }] }],
];
for (const [label, payload] of BAD_BRIEFS) {
  check(`advisor-write: rejects ${label}`, () => {
    const r = run(['agents/advisor-write.mjs'], JSON.stringify(payload));
    assert(r.code !== 0, 'accepted a brief it should have refused');
    assert(dataNow() === snapshot, 'a rejected brief still wrote to the data file');
    return 'refused, wrote nothing';
  });
}

check('advisor-write: zero recommendations is valid', () => {
  const r = run(['agents/advisor-write.mjs', '--dry-run'], JSON.stringify({ asOf: '2026-08-15', recommendations: [], unactioned: [] }));
  assert(r.code === 0, `rejected a legitimately empty brief: ${r.out}`);
  return 'accepted';
});

check('faq-check: the live FAQ carries no sendable placeholder', () => {
  const r = run(['agents/faq-check.mjs']);
  assert(r.code === 0, `the live FAQ has a half-filled answer that would be sent verbatim: ${r.out}`);
  assert(/escalat/i.test(r.out), 'no verdict about escalation');
  return (r.out.match(/coverage\s+(\d+%)/) || [])[1] || 'reported';
});

/* Answers now sit next to `> Source:` citations naming the Notion page each
   one came from. Those citations are for Evans, not for clients, and the only
   thing keeping them apart is that the parser stops at a blockquote. Delete
   that one marker while editing and a client receives "Source: Gerlach Master
   Plan, hard blockers" appended to their answer. This asserts the separation
   holds on the real file rather than trusting that nobody breaks it. */
check('faq: a source citation never becomes part of an answer', () => {
  const r = run(['agents/faq-check.mjs', '--json']);
  const report = JSON.parse(r.out);
  assert(report.total > 0, 'parsed no questions at all');
  const leaked = report.entries.filter((e) => /\bSource:/i.test(e.answer));
  assert(!leaked.length, `citation leaked into the answer for: ${leaked.map((e) => e.question).join('; ')}`);
  /* Without this the check passes vacuously the day every answer is empty. */
  assert(report.answered > 0, 'no answered questions, so this proves nothing');
  return `${report.answered} answered, none carrying a citation`;
});

check('faq-check: a half-filled answer fails', () => {
  const tmp = join(ROOT, 'test', '.tmp-faq.md');
  const src = readFileSync(join(ROOT, 'agents', 'faq.md'), 'utf8');
  /* Anchored to the start of a line so this replaces a real ANSWER. An
     unanchored match hits the prose in the preamble that merely mentions
     [FILL IN], leaving every answer untouched — a test that passes while
     proving nothing, which is worse than one that fails. */
  const broken = src.replace(/^\[FILL IN[^\]]*\]/m, 'Grab a slot at <your booking link> and I will confirm.');
  assert(broken !== src, 'the fixture did not actually break an answer');
  execFileSync('bash', ['-c', `cat > ${JSON.stringify(tmp)}`], { input: broken });
  const r = run(['agents/faq-check.mjs', '--file', tmp]);
  execFileSync('rm', ['-f', tmp]);
  assert(r.code !== 0, 'a placeholder that would be sent to a client passed the check');
  return 'caught';
});

check('operator-triage: gates fire before any FAQ lookup', () => {
  const r = run(['agents/operator-triage.mjs']);
  assert(r.code === 0, `exit ${r.code}`);
  for (const gate of ['refund', 'complaint', 'legal', 'negotiation', 'timeline']) {
    assert(new RegExp(gate, 'i').test(r.out), `no message hit the ${gate} gate`);
  }
  return (r.out.match(/escalate\s+(\d+)/) || [])[1] + ' escalated';
});

check('operator-triage: refuses input that is not a local JSON file', () => {
  const r = run(['agents/operator-triage.mjs', '--input', '/etc/passwd']);
  assert(r.code !== 0, 'read a non-JSON path');
  return 'refused';
});

check('operator-report: an omitted count is null, never zero', () => {
  const r = run(['agents/operator-report.mjs', '--resolved', '0', '--escalated', '7']);
  assert(r.code === 0, `exit ${r.code}: ${r.out}`);
  const d = JSON.parse(readFileSync(DATA, 'utf8'));
  const { resolved, drafted, escalated } = d.operator;
  const advisorSurvived = (d.advisor.recommendations || []).length;
  restoreData();
  assert(resolved.v === 0, 'a measured zero was not stored as zero');
  assert(drafted.v === null, 'an unmeasured count was invented as a number');
  assert(escalated.v === 7, 'a measured count was lost');
  assert(advisorSurvived > 0, 'writing operator counts destroyed the advisor brief');
  return 'zero and null stay distinct';
});

for (const [label, args] of [
  ['a negative count', ['--resolved', '-1']],
  ['a fractional count', ['--resolved', '2.5']],
  ['a misspelled flag', ['--escalted', '3']],
]) {
  check(`operator-report: refuses ${label}`, () => {
    const r = run(['agents/operator-report.mjs', ...args]);
    assert(r.code !== 0, 'accepted bad input');
    assert(dataNow() === snapshot, 'a refused run still wrote');
    return 'refused, wrote nothing';
  });
}

/* The standalone build is the copy that gets hosted or emailed, which makes it
   the copy most likely to be read by someone who cannot check it against the
   vault. Two things must hold: the figures are actually inside it, and it says
   out loud that they are frozen. */
check('build-standalone: bakes the data in and labels itself a snapshot', () => {
  const out = join(ROOT, 'test', '.tmp-standalone.html');
  const r = run(['agents/build-standalone.mjs', '--out', out]);
  assert(r.code === 0, `build failed: ${r.out}`);
  const built = readFileSync(out, 'utf8');
  execFileSync('rm', ['-f', out]);

  assert(built.includes('const INLINE_DATA = {'), 'no data was baked in');
  assert(!/await fetch\(DATA_URL/.test(built), 'still fetches at runtime — it would show mock data when hosted');
  assert(/SNAPSHOT · \d{4}-\d{2}-\d{2}/.test(built), 'no dated SNAPSHOT pill — a frozen page that looks live');
  /* Proof the bake is real rather than an empty object that happens to parse. */
  const live = JSON.parse(readFileSync(join(ROOT, 'data', 'jarvis-data.json'), 'utf8'));
  assert(built.includes(JSON.stringify(live.meta.operator)), 'baked data does not match the real file');
  return 'baked, and labelled';
});

check('build-standalone: refuses to build when the loader has changed', () => {
  /* The whole safety of this script is that it fails loudly instead of quietly
     emitting a page that shows mock numbers under a LIVE badge. That guarantee
     is worth nothing untested. */
  const src = readFileSync(join(ROOT, 'jarvis.html'), 'utf8');
  const broken = join(ROOT, 'test', '.tmp-jarvis.html');
  const out = join(ROOT, 'test', '.tmp-nope.html');
  execFileSync('bash', ['-c', `cat > ${JSON.stringify(broken)}`], {
    input: src.replace("const res = await fetch(DATA_URL, { cache: 'no-store' });", 'const res = await grabTheData();')
  });
  /* Swap the real page for the mangled one just long enough to run the build. */
  const backup = join(ROOT, 'test', '.tmp-jarvis-backup.html');
  execFileSync('bash', ['-c', `cat > ${JSON.stringify(backup)}`], { input: src });
  execFileSync('bash', ['-c', `cp ${JSON.stringify(broken)} ${JSON.stringify(join(ROOT, 'jarvis.html'))}`]);
  const r = run(['agents/build-standalone.mjs', '--out', out]);
  execFileSync('bash', ['-c', `cp ${JSON.stringify(backup)} ${JSON.stringify(join(ROOT, 'jarvis.html'))}`]);
  const emitted = existsSync(out);
  execFileSync('rm', ['-f', broken, backup, out]);

  assert(r.code !== 0, 'built anyway against a loader it did not recognise');
  assert(!emitted, 'emitted a file despite failing — it would silently show mock data');
  assert(/loader has changed/i.test(r.out), `unhelpful error: ${r.out.slice(0, 120)}`);
  /* The page must be exactly as it was, or this test just broke the repo. */
  assert(readFileSync(join(ROOT, 'jarvis.html'), 'utf8') === src, 'did not restore jarvis.html');
  return 'refused, and restored the page';
});

check('no employment income anywhere in the repo', () => {
  const hits = execFileSync('bash', ['-c',
    `grep -rniE "salary|sign[- ]on bonus" --include=*.json --include=*.mjs ${JSON.stringify(ROOT)}/data ${JSON.stringify(ROOT)}/agents || true`
  ], { encoding: 'utf8' }).trim();
  assert(hits === '', `employment income found: ${hits.slice(0, 100)}`);
  return 'clean';
});

/* ============================================================ the screen == */

if (!CLI_ONLY) {
  /* Resolve Playwright wherever it lives: installed in the project (CI), or
     globally (this dev container). Hardcoding either path makes the suite
     runnable in exactly one place, which defeats the point of having it. */
  const { chromium } = await (async () => {
    const tried = [];
    for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
      try {
        return await import(spec);
      } catch (err) {
        tried.push(`${spec} (${String(err.code || err.message).slice(0, 40)})`);
      }
    }
    /* Say what was attempted. The first version of this swallowed the real
       reason and surfaced an opaque ERR_MODULE_NOT_FOUND for the fallback
       path, which sent me looking in the wrong place. */
    throw new Error('Playwright not found. Tried: ' + tried.join(' | ') +
      '. Install it with: npm install --no-save playwright');
  })();

  const serve = (port, dir) => spawn('npx', ['--no-install', 'http-server', dir, '-p', String(port), '-s', '--cors'],
    { cwd: ROOT, stdio: 'ignore', detached: true });
  const servers = [serve(PORT, '.'), serve(MOCK_PORT, 'test/fixtures')];
  await new Promise((r) => setTimeout(r, 2500));

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  /** A page with stubbed voices and deterministic audio playback. */
  /**
   * opts.noVoices  — pretend the OS has no speech voices at all.
   * opts.blockPlay — make audio.play() reject, as an autoplay block does.
   *
   * Both stubs exist because the defaults below hide real bugs. Stubbing
   * getVoices to a populated list meant no test ever saw the empty-list
   * branch, and resolving play() unconditionally meant no test ever saw a
   * rejection. Each of those blind spots was concealing a live defect.
   */
  async function page(kokoroMode, opts) {
    const noVoices = !!(opts && opts.noVoices);
    const blockPlay = !!(opts && opts.blockPlay);
    const p = await browser.newPage({ viewport: { width: 1440, height: 820 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((cfg) => {
      const fake = cfg.noVoices
        ? []
        : [{ name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' }];
      Object.defineProperty(window.speechSynthesis, 'getVoices', { value: () => fake, configurable: true });
      /* Deterministic playback: real audio devices are not guaranteed headless,
         and a flaky play() would make these tests lie in both directions. */
      window.__blobs = 0;
      const realCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__blobs++; return realCreate(b); };
      HTMLMediaElement.prototype.play = function () {
        if (cfg.blockPlay) return Promise.reject(new Error('NotAllowedError: autoplay blocked'));
        setTimeout(() => { this.onplay && this.onplay(); }, 10);
        setTimeout(() => { this.onended && this.onended(); }, 60);
        return Promise.resolve();
      };
    }, { noVoices, blockPlay });
    await p.goto(`http://127.0.0.1:${PORT}/jarvis.html`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2600);
    if (kokoroMode) {
      await p.evaluate((url) => { KOKORO.cdn = url; }, `http://127.0.0.1:${MOCK_PORT}/kokoro-mock.mjs?mode=${kokoroMode}`);
    }
    return { p, errors };
  }

  const logs = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' .log-line')].map((e) => e.textContent), sel);

  console.log('\nTHE SCREEN\n');

  await checkAsync('boots clean, no scroll, all panels', async () => {
    const { p, errors } = await page();
    const r = await p.evaluate(() => ({
      panels: document.querySelectorAll('.boot.on').length,
      total: document.querySelectorAll('.boot').length,
      scrollY: document.documentElement.scrollHeight - window.innerHeight,
      scrollX: document.documentElement.scrollWidth - window.innerWidth,
      pill: document.getElementById('pillData').textContent,
    }));
    await p.close();
    assert(errors.length === 0, `page errors: ${errors[0]}`);
    assert(r.panels === r.total, `${r.panels}/${r.total} panels booted`);
    assert(r.scrollY <= 0 && r.scrollX <= 0, 'the one-screen rule broke');
    return r.pill;
  });

  await checkAsync('refuses to invent an unwired figure', async () => {
    const { p } = await page();
    const a = await p.evaluate(() => answer('how much did i make yesterday').text);
    await p.close();
    assert(/unavailable/i.test(a), `answered an unwired field: ${a.slice(0, 60)}`);
    return 'says unavailable';
  });

  await checkAsync('never recites a percentage against a placeholder target', async () => {
    const { p } = await page();
    const brief = await p.evaluate(() => {
      MISSION_DATA.objective.target = { v: 10000, source: 'PLACEHOLDER: set your real monthly target', asOf: '2026-08-15' };
      MISSION_DATA.objective.current = { v: 2500, source: 'x', asOf: '2026-08-15' };
      return morningBrief().text;
    });
    await p.close();
    assert(/placeholder/i.test(brief), 'spoke a percentage without flagging the placeholder');
    return 'flagged';
  });

  await checkAsync('pipeline totals exclude items with no agreed figure', async () => {
    const { p } = await page();
    const t = await p.evaluate(() => {
      MISSION_DATA.pipeline = { asOf: '2026-08-15', source: 'test', items: [
        { name: 'A', stage: 'ACTIVE', value: 1000, note: 'x' },
        { name: 'B', stage: 'PROSPECT', value: null, note: 'no agreed figure' },
      ] };
      return answer('pipeline').text;
    });
    await p.close();
    assert(/\$1,000/.test(t), 'lost a known figure');
    assert(/1 with an agreed figure|no agreed figure/i.test(t), 'silently counted an unpriced item');
    return 'excluded, and said so';
  });

  await checkAsync('stale advice is flagged, on screen and out loud', async () => {
    const { p } = await page();
    const r = await p.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() - 3);
      const iso = d.toISOString().slice(0, 10);
      MISSION_DATA.advisor = { asOf: iso, unactioned: [],
        recommendations: [{ action: 'a', evidence: 'b', cost: 'c' }] };
      updateAdvicePill();
      return { pill: document.getElementById('pillAdvice').textContent, brief: morningBrief().text };
    });
    await p.close();
    assert(/3D OLD/.test(r.pill), `pill did not flag the age: ${r.pill}`);
    assert(/3 days old/.test(r.brief), 'the spoken brief presented stale advice as todays');
    return 'flagged both ways';
  });

  await checkAsync('advice published today is not flagged as stale', async () => {
    const { p } = await page();
    const r = await p.evaluate(() => {
      const iso = new Date().toISOString().slice(0, 10);
      MISSION_DATA.advisor = { asOf: iso, unactioned: [],
        recommendations: [{ action: 'a', evidence: 'b', cost: 'c' }] };
      updateAdvicePill();
      return { pill: document.getElementById('pillAdvice').textContent, brief: morningBrief().text };
    });
    await p.close();
    assert(/TODAY/.test(r.pill), `fresh advice was not marked current: ${r.pill}`);
    assert(!/days old/.test(r.brief), 'cried stale on advice written today');
    return 'clean';
  });

  await checkAsync('an Advisor that never ran says so rather than showing an age', async () => {
    const { p } = await page();
    const pill = await p.evaluate(() => {
      MISSION_DATA.advisor = { asOf: '2026-08-15', recommendations: [], unactioned: [] };
      updateAdvicePill();
      return document.getElementById('pillAdvice').textContent;
    });
    await p.close();
    assert(/NOT RUN/.test(pill), `wrong state for an unrun Advisor: ${pill}`);
    return 'says not run';
  });

  await checkAsync('voice picker lists Kokoro first, UK voices next', async () => {
    const { p } = await page();
    const opts = await p.evaluate(() => [...document.getElementById('voicePick').options].map((o) => o.text));
    await p.close();
    assert(/KOKORO/.test(opts[0]), `Kokoro not offered first: ${opts[0]}`);
    assert(/DOWNLOADS ONCE/.test(opts[0]), 'the download cost is not disclosed in the label');
    assert(/UK/.test(opts[1]), `British voice not prioritised: ${opts[1]}`);
    return opts.length + ' options';
  });

  console.log('\nKOKORO (against a mock — proves our half, not the library)\n');

  /** Select Kokoro and wait for it to settle. */
  async function runKokoro(mode) {
    const { p, errors } = await page(mode);
    await p.selectOption('#voicePick', '__kokoro__');
    await p.waitForTimeout(1800);
    const diag = await logs(p, '#diagnostics');
    const tele = await logs(p, '#telemetry');
    const state = await p.evaluate(() => document.getElementById('waveState').textContent);
    const blobs = await p.evaluate(() => window.__blobs);
    const saved = await p.evaluate(() => localStorage.getItem('jarvisVoice'));
    await p.close();
    return { diag, tele, state, blobs, saved, errors };
  }

  await checkAsync('toBlob() result → speaks, returns to idle', async () => {
    const r = await runKokoro('toBlob');
    assert(r.errors.length === 0, `page errors: ${r.errors[0]}`);
    assert(r.diag.some((l) => /KOKORO: READY/.test(l)), 'never became ready');
    assert(!r.diag.some((l) => /KOKORO FAILED/.test(l)), 'fell back when it should have worked');
    assert(r.blobs > 0, 'no audio blob was produced');
    assert(r.state === 'NO SIGNAL', `stuck in state: ${r.state}`);
    return 'spoke and settled';
  });

  await checkAsync('raw samples result → our WAV encoder handles it', async () => {
    const r = await runKokoro('raw');
    assert(!r.diag.some((l) => /KOKORO FAILED/.test(l)), 'could not handle raw samples');
    assert(r.blobs > 0, 'no WAV produced from raw samples');
    return 'encoded and played';
  });

  await checkAsync('progress keeps reporting past the first file', async () => {
    const r = await runKokoro('toBlob');
    const pct = r.tele.filter((l) => /KOKORO: \S+ \d+%/.test(l));
    assert(pct.length >= 3, `only ${pct.length} progress lines — a silent download looks frozen`);
    /* The defect this catches: one global high-water mark reports every
       percent of the first file, then drops every later file's progress
       because it never exceeds 100. The readout dies partway through a
       several-hundred-megabyte download and the page looks hung. */
    assert(pct.some((l) => /VOICES\.BIN/.test(l)),
      'went silent after the first file finished — later files reported nothing');
    return pct.length + ' updates across 2 files';
  });

  await checkAsync('a device with no OS voices can still reach Kokoro', async () => {
    const { p, errors } = await page(null, { noVoices: true });
    const r = await p.evaluate(() => {
      const sel = document.getElementById('voicePick');
      return { opts: [...sel.options].map((o) => o.text), disabled: sel.disabled };
    });
    await p.close();
    assert(errors.length === 0, `page errors: ${errors[0]}`);
    /* Kokoro runs in the browser and needs no installed voice, so this is the
       one machine where it is the ONLY route to speech. The picker used to
       return early here and show a disabled "NO VOICES", hiding the single
       option that would have worked. */
    assert(!r.disabled, 'the picker was disabled, leaving no way to select anything');
    assert(r.opts.some((o) => /KOKORO/.test(o)), `Kokoro not offered: ${JSON.stringify(r.opts)}`);
    return 'offered on a voiceless device';
  });

  await checkAsync('blocked playback keeps the downloaded voice', async () => {
    const { p, errors } = await page('toBlob', { blockPlay: true });
    await p.selectOption('#voicePick', '__kokoro__');
    await p.waitForTimeout(1800);
    const diag = await logs(p, '#diagnostics');
    const saved = await p.evaluate(() => localStorage.getItem('jarvisVoice'));
    const state = await p.evaluate(() => document.getElementById('waveState').textContent);
    await p.close();
    assert(errors.length === 0, `page errors: ${errors[0]}`);
    /* An autoplay block is not a Kokoro failure. The model downloaded and is
       cached; discarding the preference here would throw away several hundred
       megabytes of work over a rejected promise. */
    assert(!diag.some((l) => /KOKORO FAILED/.test(l)), 'treated an autoplay block as a model failure');
    assert(diag.some((l) => /PLAYBACK BLOCKED/.test(l)), 'said nothing about why it went quiet');
    assert(saved === '__kokoro__', `discarded the voice preference: ${saved}`);
    assert(state === 'NO SIGNAL', `left the UI stuck: ${state}`);
    return 'kept the preference, reported the block';
  });

  await checkAsync('a voice the model lacks is substituted, not failed', async () => {
    const r = await runKokoro('novoice');
    assert(r.diag.some((l) => /NOT IN MODEL/.test(l)), 'did not notice the missing voice');
    assert(r.diag.some((l) => /USING BF_EMMA/.test(l)), 'did not substitute a British voice');
    assert(!r.diag.some((l) => /KOKORO FAILED/.test(l)), 'failed instead of substituting');
    return 'substituted bf_emma';
  });

  for (const [mode, label] of [['garbage', 'an unrecognised result'], ['loadfail', 'the model host failing'], ['noexport', 'a renamed library API']]) {
    await checkAsync(`falls back on ${label}`, async () => {
      const r = await runKokoro(mode);
      assert(r.errors.length === 0, `page errors: ${r.errors[0]}`);
      assert(r.diag.some((l) => /KOKORO FAILED/.test(l)), 'no failure was reported to the operator');
      assert(r.saved !== '__kokoro__', 'kept a broken preference — it would retry every morning');
      assert(r.state === 'NO SIGNAL', `left the UI stuck: ${r.state}`);
      return 'fell back, cleared preference, logged why';
    });
  }

  await checkAsync('never downloads on page load alone', async () => {
    const { p, errors } = await page('toBlob');
    await p.evaluate(() => localStorage.setItem('jarvisVoice', '__kokoro__'));
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    const diag = await logs(p, '#diagnostics');
    await p.close();
    assert(errors.length === 0, `page errors: ${errors[0]}`);
    assert(diag.some((l) => /HELD/.test(l)), 'started a large download with no gesture');
    return 'held until asked';
  });

  await browser.close();
  servers.forEach((s) => { try { process.kill(-s.pid); } catch (e) {} });
}

/* ==================================================================== out == */

restoreData();

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed\n`);

if (failed) {
  console.error(`${failed} FAILED`);
  process.exit(1);
}
