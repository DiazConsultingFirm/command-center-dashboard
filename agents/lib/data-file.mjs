/**
 * Canonical read/write for data/jarvis-data.json.
 *
 * Every agent that writes a section MUST go through here. The reason is a real
 * bug rather than tidiness: the Scout writes this file from Node
 * (`JSON.stringify`, raw UTF-8) while an agent hand-writing it from Python
 * escapes non-ASCII (`—` for an em dash). The bytes differ, the content
 * does not, and the next Scout run produces a commit that claims to refresh
 * the data while changing nothing but encoding. That is a history that lies
 * about when your numbers moved.
 *
 * Canonical form: JSON.stringify(value, null, 2) + trailing newline, no
 * unicode escaping. One writer, one encoding, and a diff means a real change.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_PATH = join(ROOT, 'data', 'jarvis-data.json');

/** Sections the dashboard reads. Anything else in the file is ignored by it. */
export const SECTIONS = ['meta', 'objective', 'revenue', 'book', 'pipeline', 'operator', 'advisor', 'proximity'];

export function readData() {
  if (!existsSync(DATA_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`data/jarvis-data.json is not valid JSON (${err.message}). Rerun the Scout rather than hand-repairing it.`);
  }
}

export function serialize(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

/** Write the whole file in canonical form. Returns true if the bytes changed. */
export function writeData(data) {
  const next = serialize(data);
  const prev = existsSync(DATA_PATH) ? readFileSync(DATA_PATH, 'utf8') : null;
  if (prev === next) return false;
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, next);
  return true;
}

/**
 * Merge one section and write. Returns { changed } so a caller can skip an
 * empty commit — a commit that changes nothing is noise in the history.
 */
export function writeSection(name, value) {
  if (!SECTIONS.includes(name)) {
    throw new Error(`"${name}" is not a section the dashboard reads. Valid: ${SECTIONS.join(', ')}`);
  }
  const data = readData();
  data[name] = value;
  return { changed: writeData(data) };
}

/** Today in the ISO form every asOf field uses. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
