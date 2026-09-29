// Checks a Vitest benchmark report (--outputJson) against the budgets in
// the benchmark names: "... (budget 1 ms)" has to take at most 1 ms (its
// 75th percentile, which a garbage collection now and then does not move).
// Exits with 1 when one takes longer.
//
//   node editor/test/bench/budgets.mjs editor/bench-results.json

import fs from 'fs';

const file = process.argv[2];
if (!file) {
    console.error('Usage: node budgets.mjs <report.json>');
    process.exit(2);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = [];
for (const f of report.files) {
    for (const group of f.groups) {
        for (const b of group.benchmarks) {
            const m = /\(budget ([\d.]+) ms\)/.exec(b.name);
            if (!m) continue;
            const budget = Number(m[1]);
            rows.push({ group: group.fullName.replace(/^.*? > /, ''), name: b.name, p75: b.p75, mean: b.mean, budget, ok: b.p75 <= budget });
        }
    }
}
if (!rows.length) {
    console.error(`No benchmarks with a budget in ${file}.`);
    process.exit(2);
}
const ms = (v) => (v < 0.01 ? v.toFixed(4) : v.toFixed(2)) + ' ms';
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'OVER'}  ${ms(r.p75).padStart(11)} of ${ms(r.budget).padStart(9)}  ${r.group}: ${r.name}`);
const over = rows.filter((r) => !r.ok);
if (over.length) {
    console.error(`\n${over.length} benchmark${over.length === 1 ? '' : 's'} over budget.`);
    process.exit(1);
}
console.log(`\nAll ${rows.length} benchmarks within budget.`);
