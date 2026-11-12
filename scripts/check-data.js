#!/usr/bin/env node
/**
 * Data check for the course plan.
 *
 * Validates DEFAULT_COURSES + the semester list inside index.html so a typo in
 * the plan fails CI instead of shipping a broken page.
 *
 *   node scripts/check-data.js
 *
 * No dependencies — it parses the single-file app directly.
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [key, value] = a.replace(/^--/, '').split('=');
      return [key, value === undefined ? 'true' : value];
    })
);
const HTML_ARG = argv.find((a) => !a.startsWith('--'));
const HTML_PATH = HTML_ARG
  ? path.resolve(HTML_ARG)
  : path.join(__dirname, '..', 'index.html');

/* The plan is allowed to grow, so the exact size is not enforced by default.
   Pass --courses=22 (or set EXPECTED_COURSES=22) to pin it and catch an entry
   that was dropped by accident. */
const EXPECTED_RAW = flags.get('courses') ?? process.env.EXPECTED_COURSES;
const EXPECTED_COURSES = EXPECTED_RAW == null ? null : Number(EXPECTED_RAW);

const VALID_STATUS = ['planned', 'in-progress', 'done'];
const VALID_CAT = ['other', 'ge', 'major', 'elective'];
const KINDS = [
  { prefix: 'sp', name: 'Spring' },
  { prefix: 'su', name: 'Summer' },
  { prefix: 'fa', name: 'Fall' },
  { prefix: 'wi', name: 'Winter' },
];

const errors = [];
const fail = (msg) => errors.push(msg);

function readBlock(html, start, open, close) {
  const at = html.indexOf(start);
  if (at === -1) throw new Error(`cannot find "${start}" in index.html`);
  const from = html.indexOf(open, at) + 1;
  let depth = 1;
  for (let i = from; i < html.length; i++) {
    if (html[i] === open) depth++;
    else if (html[i] === close) {
      depth--;
      if (depth === 0) return html.slice(from, i);
    }
  }
  throw new Error(`unbalanced "${open}${close}" after "${start}"`);
}

const html = fs.readFileSync(HTML_PATH, 'utf8');

/* ── semester list ── */
const yearsRaw = html.match(/const TERM_YEARS\s*=\s*\[([^\]]*)\]/);
if (!yearsRaw) {
  console.error('✗ cannot find TERM_YEARS in index.html');
  process.exit(1);
}
const TERM_YEARS = yearsRaw[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
TERM_YEARS.forEach((y) => {
  if (!Number.isInteger(y) || y < 2000 || y > 2100) fail(`TERM_YEARS contains a bad year: ${y}`);
});

const semesters = [];
TERM_YEARS.forEach((y) =>
  KINDS.forEach((k) => {
    const year = k.prefix === 'wi' ? y + 1 : y;
    const id = `${k.prefix}${year}`;
    if (!semesters.some((s) => s.id === id)) semesters.push({ id, label: `${year} ${k.name}` });
  })
);
const semById = new Map(semesters.map((s) => [s.id, s]));

/* ── courses ── */
let courses;
try {
  const src = readBlock(html, 'const DEFAULT_COURSES', '[', ']');
  courses = new Function(`const uid=()=>'x'; return [${src}];`)();
} catch (err) {
  console.error('✗ cannot parse DEFAULT_COURSES:', err.message);
  process.exit(1);
}

if (!Array.isArray(courses) || !courses.length) fail('DEFAULT_COURSES is empty');
else if (EXPECTED_COURSES != null) {
  if (!Number.isInteger(EXPECTED_COURSES) || EXPECTED_COURSES < 1) {
    fail(`--courses must be a positive integer (got "${EXPECTED_RAW}")`);
  } else if (courses.length !== EXPECTED_COURSES) {
    fail(`expected ${EXPECTED_COURSES} courses, found ${courses.length} (update --courses / EXPECTED_COURSES if the plan changed)`);
  }
}

const seen = new Map();
let totalUnits = 0;
const byTerm = new Map();

courses.forEach((c, i) => {
  const where = `course #${i + 1} (${c && c.code ? c.code : 'no code'})`;

  if (!c || typeof c !== 'object') return fail(`${where}: not an object`);
  if (typeof c.code !== 'string' || !c.code.trim()) fail(`${where}: missing code`);
  if (typeof c.title !== 'string' || !c.title.trim()) fail(`${where}: missing title`);

  const units = Number(c.units);
  if (!Number.isFinite(units) || units < 0.5 || units > 30) fail(`${where}: bad units "${c.units}"`);
  else totalUnits += units;

  if (!VALID_STATUS.includes(c.status)) fail(`${where}: bad status "${c.status}" (allowed: ${VALID_STATUS.join(', ')})`);
  if (!VALID_CAT.includes(c.cat)) fail(`${where}: bad category "${c.cat}" (allowed: ${VALID_CAT.join(', ')})`);
  if (c.notes != null && typeof c.notes !== 'string') fail(`${where}: notes must be a string`);

  const sem = typeof c.sem === 'string' ? c.sem.trim() : '';
  if (!sem) fail(`${where}: missing semester (use "unassigned" if intentional)`);
  else if (sem !== 'unassigned' && !semById.has(sem)) {
    fail(`${where}: semester "${sem}" is outside TERM_YEARS ${TERM_YEARS.join('/')}`);
  }

  const key = String(c.code || '').trim().toLowerCase();
  if (key) {
    if (seen.has(key)) fail(`duplicate course code: ${c.code} (#${seen.get(key) + 1} and #${i + 1})`);
    else seen.set(key, i);
  }

  if (sem && sem !== 'unassigned') {
    if (!byTerm.has(sem)) byTerm.set(sem, { count: 0, units: 0, status: {} });
    const t = byTerm.get(sem);
    t.count++;
    t.units += Number(c.units) || 0;
    t.status[c.status] = (t.status[c.status] || 0) + 1;
  }
});

/* ── report ── */
console.log(`index.html — ${courses.length} courses, ${totalUnits} units\n`);
semesters
  .filter((s) => byTerm.has(s.id))
  .forEach((s) => {
    const t = byTerm.get(s.id);
    const states = Object.entries(t.status).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`  ${s.label.padEnd(14)} ${String(t.count).padStart(2)} courses  ${String(t.units).padStart(2)} units  (${states})`);
  });
console.log(`\n  ${'TOTAL'.padEnd(14)} ${String(courses.length).padStart(2)} courses  ${String(totalUnits).padStart(2)} units`);

if (errors.length) {
  console.error('\n✗ ' + errors.length + ' problem(s) found:');
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('\n✓ course data is valid');
