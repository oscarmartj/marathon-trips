#!/usr/bin/env node
// Checks the dependency table in docs/autonomous.md against docs/phases/*.md.
// No dependencies: run with `node scripts/check-dependency-table.mjs`.
// Fails (exit 1) on: unknown task IDs, duplicate rows, tasks missing from either side,
// malformed dependency tokens, cycles, or an active task depending on a parked one.
// "fase N cerrada" means every non-parked task of phase N. The risk cell may carry a
// suffix after " · ": "aparcada (dinero)" (parked) or "parcial: …" (partial scope).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const taskRow = /^\|\s*(\d+\.\d+)\s*\|/;

// Tasks declared in phase files. A task may appear more than once in the same phase
// (phase 9 lists 9.1 and 9.2 under both payment paths); that is intentional.
const phaseTasks = new Map(); // id -> phase number
const phasesDir = join(root, 'docs/phases');
for (const file of readdirSync(phasesDir).filter((f) => /^phase-\d+\.md$/.test(f))) {
  const phase = Number(file.match(/\d+/)[0]);
  for (const line of readFileSync(join(phasesDir, file), 'utf8').split('\n')) {
    const m = line.match(taskRow);
    if (!m) continue;
    const id = m[1];
    if (Number(id.split('.')[0]) !== phase) errors.push(`${file}: task ${id} is not in phase ${phase}`);
    phaseTasks.set(id, phase);
  }
}

// Dependency table in docs/autonomous.md.
const auto = readFileSync(join(root, 'docs/autonomous.md'), 'utf8');
const section = auto.split('## Tabla de dependencias')[1]?.split('\n## ')[0];
if (!section) {
  console.error('docs/autonomous.md: "## Tabla de dependencias" not found');
  process.exit(1);
}
const deps = new Map(); // id -> Set of task ids
const parked = new Set();
const rows = [];
const risks = new Set(['Bajo', 'Medio', 'Alto', 'Arquitectura']);
for (const line of section.split('\n')) {
  const m = line.match(taskRow);
  if (!m) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const [id, depCell, riskCell] = cells;
  if (rows.some((r) => r.id === id)) errors.push(`autonomous.md: duplicate row ${id}`);
  const [risk, tag] = riskCell.split(' · ');
  if (!risks.has(risk)) errors.push(`autonomous.md: ${id} has unknown risk "${risk}"`);
  if (tag === 'aparcada (dinero)') parked.add(id);
  else if (tag !== undefined && !tag.startsWith('parcial: ')) errors.push(`autonomous.md: ${id} has unknown tag "${tag}"`);
  rows.push({ id, depCell });
}
for (const { id, depCell } of rows) {
  const set = new Set();
  if (depCell !== '—') {
    for (const token of depCell.split(',').map((t) => t.trim())) {
      const closed = token.match(/^fase (\d+) cerrada$/);
      if (closed) {
        const phase = Number(closed[1]);
        const all = [...phaseTasks].filter(([, p]) => p === phase).map(([t]) => t);
        if (all.length === 0) errors.push(`autonomous.md: ${id} depends on empty phase ${phase}`);
        const members = all.filter((t) => !parked.has(t));
        members.forEach((t) => set.add(t));
      } else if (/^\d+\.\d+$/.test(token)) {
        set.add(token);
      } else {
        errors.push(`autonomous.md: ${id} has malformed dependency "${token}"`);
      }
    }
  }
  deps.set(id, set);
}

for (const [id, set] of deps) {
  if (!phaseTasks.has(id)) errors.push(`autonomous.md: ${id} is not a task in docs/phases`);
  for (const d of set) {
    if (!deps.has(d)) errors.push(`autonomous.md: ${id} depends on unknown task ${d}`);
    if (d === id) errors.push(`autonomous.md: ${id} depends on itself`);
    if (!parked.has(id) && parked.has(d)) errors.push(`autonomous.md: ${id} depends on parked task ${d}`);
  }
}
for (const id of phaseTasks.keys()) {
  if (!deps.has(id)) errors.push(`docs/phases: ${id} has no row in the dependency table`);
}

// Cycle detection (depth-first, three colours).
const colour = new Map();
const visit = (id, path) => {
  if (colour.get(id) === 'done') return;
  if (colour.get(id) === 'active') {
    errors.push(`cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}`);
    return;
  }
  colour.set(id, 'active');
  for (const d of deps.get(id) ?? []) if (deps.has(d)) visit(d, [...path, id]);
  colour.set(id, 'done');
};
for (const id of deps.keys()) visit(id, []);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`OK: ${deps.size} rows (${parked.size} parked), ${phaseTasks.size} tasks in docs/phases, no cycles, no unknown IDs, no active task waits on a parked one.`);
