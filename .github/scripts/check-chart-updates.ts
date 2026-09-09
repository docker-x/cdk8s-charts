import { execFileSync, type StdioOptions } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DiscoveredChart, discoverCharts } from './lib/discover-charts.ts';
import { helmLatestVersion, isNewer } from './lib/helm-utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CHART_INDEX = join(REPO_ROOT, '.github', 'chart-index.json');
const DRY_RUN = process.argv.includes('--dry-run');

function run(cmd: string, args: string[], opts: { cwd?: string; stdio?: StdioOptions } = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function getRepoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = run('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function repoArgs() {
  const slug = getRepoSlug();
  return slug ? ['--repo', slug] : [];
}

interface Issue {
  number: number;
  title: string;
  updatedAt: string;
}

function findOpenIssues(name: string): Issue[] {
  const searchQuery = `Update ${name} to`;
  try {
    const output = run('gh', [
      'search',
      'issues',
      searchQuery,
      ...repoArgs(),
      '--state',
      'open',
      '--match',
      'title',
      '--sort',
      'updated',
      '--order',
      'desc',
      '--limit',
      '10',
      '--json',
      'number,title,updatedAt',
    ]);
    return JSON.parse(output) as Issue[];
  } catch {
    return [];
  }
}

function closeIssue(number: number) {
  if (DRY_RUN) {
    console.log(`[dry-run] would close duplicate issue #${number}`);
    return;
  }
  run('gh', [
    'issue',
    'close',
    String(number),
    ...repoArgs(),
    '--comment',
    'Superseded by a newer version update.',
  ]);
}

function issueBody(
  name: string,
  version: string,
  chart: string,
  repo?: string,
  currentVersion?: string,
) {
  const ref = repo ? `${chart} --repo ${repo}` : chart;
  const lines = [`A new upstream Helm chart version is available for **${name}**: \`${version}\`.`];
  if (currentVersion) {
    lines.push('', `**Current pinned version:** \`${currentVersion}\``);
  }
  lines.push(
    '',
    '**Chart reference:**',
    `\`${ref}\``,
    '',
    'Next steps (manual):',
    `1. Inspect the new Helm values: \`helm show values ${ref}\``,
    `2. Update \`packages/charts/${name}/src/construct.ts\` and regenerate types if the schema changed.`,
    '3. Run the build and example to verify the updated chart still synthesizes.',
    '',
    '<!-- chart-update -->',
  );
  return lines.join('\n');
}

function upsertIssue(
  number: number | undefined,
  name: string,
  version: string,
  chart: string,
  repo?: string,
  currentVersion?: string,
) {
  const title = `Update ${name} to ${version}`;
  const body = issueBody(name, version, chart, repo, currentVersion);

  if (DRY_RUN) {
    const action = number ? `update issue #${number}` : 'create issue';
    console.log(`[dry-run] would ${action}: ${title}`);
    return;
  }

  if (number) {
    run('gh', ['issue', 'edit', String(number), '--title', title, '--body', body, ...repoArgs()]);
    console.log(`  updated issue #${number}: ${title}`);
  } else {
    const output = run('gh', ['issue', 'create', '--title', title, '--body', body, ...repoArgs()]);
    console.log(`  created issue: ${title} (${output.trim()})`);
  }
}

function closeStaleIssue(number: number, name: string) {
  if (DRY_RUN) {
    console.log(`[dry-run] would close stale issue #${number} for ${name} (now up to date)`);
    return;
  }
  run('gh', [
    'issue',
    'close',
    String(number),
    ...repoArgs(),
    '--comment',
    'Chart is now up to date. Closing.',
  ]);
  console.log(`  closed stale issue #${number} for ${name} (now up to date)`);
}

function processChart(chart: DiscoveredChart, latestVersion: string) {
  const title = `Update ${chart.name} to ${latestVersion}`;
  const issues = findOpenIssues(chart.name);
  const isOutdated = isNewer(chart.currentVersion, latestVersion);

  // Chart is up to date: close any leftover open update issues.
  if (!isOutdated) {
    for (const issue of issues) {
      console.log(`  closing stale issue #${issue.number} for ${chart.name} (now up to date)`);
      closeStaleIssue(issue.number, chart.name);
    }
    console.log(`  up to date: ${chart.name} @ ${latestVersion}`);
    return;
  }

  // No open issue -> create one.
  if (issues.length === 0) {
    upsertIssue(
      undefined,
      chart.name,
      latestVersion,
      chart.chart,
      chart.repo,
      chart.currentVersion,
    );
    return;
  }

  // Keep the most recently updated issue and close any duplicates.
  const [primary, ...duplicates] = issues;
  for (const duplicate of duplicates) {
    console.log(`  closing duplicate issue #${duplicate.number} for ${chart.name}`);
    closeIssue(duplicate.number);
  }

  // If the primary issue already points to the current version, nothing to do.
  if (primary.title === title) {
    console.log(`  issue already up to date: ${title}`);
    return;
  }

  upsertIssue(
    primary.number,
    chart.name,
    latestVersion,
    chart.chart,
    chart.repo,
    chart.currentVersion,
  );
}

/**
 * Warn about Helm-wrapped charts that the auto-discovery missed.
 * Cross-checked against the legacy chart-index.json if it still exists.
 */
function warnAboutUnindexedCharts(discovered: DiscoveredChart[]): void {
  const discoveredNames = new Set(discovered.map((c) => c.name));

  // 1. Charts that call renderChart but were not discovered.
  const chartsDir = join(REPO_ROOT, 'packages', 'charts');
  for (const dir of readdirSync(chartsDir)) {
    const construct = join(chartsDir, dir, 'src', 'construct.ts');
    if (!statSync(join(chartsDir, dir)).isDirectory() || !existsSync(construct)) {
      continue;
    }
    const content = readFileSync(construct, 'utf8');
    const usesRender = content.includes('renderChart(') || content.includes('renderChartOn(');
    if (usesRender && !discoveredNames.has(dir)) {
      console.warn(`Warning: ${dir} uses renderChart/renderChartOn but was not discovered`);
    }
  }

  // 2. Entries in the legacy chart-index.json that are no longer discovered.
  if (existsSync(CHART_INDEX)) {
    try {
      const index = JSON.parse(readFileSync(CHART_INDEX, 'utf8')) as {
        charts: Array<{ name: string }>;
      };
      for (const entry of index.charts) {
        if (!discoveredNames.has(entry.name)) {
          console.warn(`Warning: ${entry.name} is in chart-index.json but was not discovered`);
        }
      }
    } catch {
      // ignore malformed index
    }
  }
}

function main() {
  const charts = discoverCharts();
  warnAboutUnindexedCharts(charts);

  if (charts.length === 0) {
    console.log('No Helm-wrapped charts discovered.');
    return;
  }

  for (const chart of charts) {
    try {
      const version = helmLatestVersion(chart.chart, chart.repo);
      const marker = chart.currentVersion
        ? isNewer(chart.currentVersion, version)
          ? `OUTDATED (current ${chart.currentVersion})`
          : 'up to date'
        : 'no pinned version';
      console.log(`${chart.name}: ${version} — ${marker}`);
      processChart(chart, version);
    } catch (error) {
      console.error(`${chart.name}: ${(error as Error).message}`);
    }
  }
}

main();
