#!/usr/bin/env node
/**
 * Local chart update report.
 *
 * Walks every Helm-wrapped chart in packages/charts/* (auto-discovered),
 * queries `helm show chart` for the latest published version, compares it
 * against the DEFAULT_VERSION pinned in the construct, and prints a table
 * of outdated charts.
 *
 * Usage:
 *   node .github/scripts/check-chart-updates-local.ts            # full report
 *   node .github/scripts/check-chart-updates-local.ts --outdated  # only outdated
 *   node .github/scripts/check-chart-updates-local.ts --json      # machine-readable
 *
 * Requires: helm on PATH (helm show chart / helm show chart oci://...).
 */

import { execFileSync, type StdioOptions } from 'node:child_process';
import { discoverCharts } from './lib/discover-charts.ts';

const ONLY_OUTDATED = process.argv.includes('--outdated');
const JSON_OUTPUT = process.argv.includes('--json');

function run(cmd: string, args: string[], opts: { stdio?: StdioOptions } = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

/** Query the latest published chart version via `helm show chart`. */
function helmLatestVersion(chart: string, repo?: string): string {
  const args = ['show', 'chart', chart];
  if (repo) args.push('--repo', repo);
  const output = run('helm', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const match = output.match(/^version:\s*(.+)$/m);
  if (!match) throw new Error('version not found in `helm show chart` output');
  return match[1].trim();
}

/**
 * Compare two versions. Returns true when `latest` is newer than `current`.
 * Falls back to string inequality when either side is missing or non-semver.
 */
function isNewer(current: string | undefined, latest: string): boolean {
  if (!current) return true;
  if (current === latest) return false;
  const c = current.split('.').map((p) => Number.parseInt(p, 10));
  const l = latest.split('.').map((p) => Number.parseInt(p, 10));
  const len = Math.max(c.length, l.length);
  for (let i = 0; i < len; i++) {
    const ci = c[i] ?? 0;
    const li = l[i] ?? 0;
    if (li > ci) return true;
    if (li < ci) return false;
  }
  return false; // equal numeric parts
}

interface ChartResult {
  name: string;
  chart: string;
  repo?: string;
  current?: string;
  latest: string;
  outdated: boolean;
  error?: string;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printTable(results: ChartResult[]): void {
  const rows = results.filter((r) => (ONLY_OUTDATED ? r.outdated : true));
  if (rows.length === 0) {
    console.log(ONLY_OUTDATED ? 'All charts are up to date.' : 'No charts discovered.');
    return;
  }

  const cols = [
    { header: 'CHART', width: 18 },
    { header: 'CURRENT', width: 12 },
    { header: 'LATEST', width: 12 },
    { header: 'STATUS', width: 10 },
    { header: 'REF', width: 0 },
  ];
  const header = cols.map((c) => pad(c.header, c.width || c.header.length)).join('  ');
  console.log(header);
  console.log('-'.repeat(Math.max(header.length, 60)));

  for (const r of rows) {
    const status = r.error ? 'ERROR' : r.outdated ? 'OUTDATED' : 'OK';
    const ref = r.repo ? `${r.chart} --repo ${r.repo}` : r.chart;
    const line = [
      pad(r.name, 18),
      pad(r.current ?? '?', 12),
      pad(r.latest ?? '?', 12),
      pad(status, 10),
      ref,
    ].join('  ');
    console.log(line);
    if (r.error) console.log(`    ${r.error}`);
  }

  const outdated = results.filter((r) => r.outdated).length;
  const errors = results.filter((r) => r.error).length;
  console.log('');
  console.log(
    `${outdated} outdated, ${results.length - outdated - errors} up to date, ${errors} errors`,
  );
}

function main(): void {
  const charts = discoverCharts();
  if (charts.length === 0) {
    console.log('No Helm-wrapped charts discovered.');
    return;
  }

  const results: ChartResult[] = [];
  for (const chart of charts) {
    const result: ChartResult = {
      name: chart.name,
      chart: chart.chart,
      repo: chart.repo,
      current: chart.currentVersion,
      latest: '',
      outdated: false,
    };
    try {
      const latest = helmLatestVersion(chart.chart, chart.repo);
      result.latest = latest;
      result.outdated = isNewer(chart.currentVersion, latest);
      console.error(
        `${chart.name}: current=${chart.currentVersion ?? '?'} latest=${latest} ${result.outdated ? '(outdated)' : '(ok)'}`,
      );
    } catch (error) {
      result.error = (error as Error).message;
      console.error(`${chart.name}: ${(error as Error).message}`);
    }
    results.push(result);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }

  const outdatedCount = results.filter((r) => r.outdated).length;
  process.exitCode = outdatedCount > 0 ? 0 : 0; // report only, never fail CI
}

main();
