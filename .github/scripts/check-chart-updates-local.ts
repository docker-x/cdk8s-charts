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

import { discoverCharts } from './lib/discover-charts.ts';
import { helmLatestVersion, isNewer } from './lib/helm-utils.ts';

const ONLY_OUTDATED = process.argv.includes('--outdated');
const JSON_OUTPUT = process.argv.includes('--json');

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
  return s.padEnd(n);
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

  // Report only — never fail CI regardless of outdated count.
  process.exitCode = 0;
}

main();
