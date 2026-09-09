/**
 * Shared Helm utilities for chart update scripts.
 *
 * Extracted to avoid duplication between check-chart-updates.ts (CI)
 * and check-chart-updates-local.ts (local report).
 */

import { execFileSync } from 'node:child_process';

/** Query the latest published chart version via `helm show chart`. */
export function helmLatestVersion(chart: string, repo?: string): string {
  const args = ['show', 'chart', chart];
  if (repo) args.push('--repo', repo);
  const output = execFileSync('helm', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const match = output.match(/^version:\s*(.+)$/m);
  if (!match) throw new Error('version not found in `helm show chart` output');
  return match[1].trim();
}

/**
 * Compare two semver-ish versions. Returns true when `latest` is newer
 * than `current`.
 *
 * Handles pre-release suffixes (e.g. `1.2.3-alpha`) by comparing the
 * numeric parts first, then falling back to string comparison for the
 * suffix. A version with a pre-release suffix is considered older than
 * the same version without one (per semver spec).
 */
export function isNewer(current: string | undefined, latest: string): boolean {
  if (!current) return true;
  if (current === latest) return false;

  // Split into numeric core and pre-release suffix.
  const parseCore = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((p) => Number.parseInt(p, 10));
  const c = parseCore(current);
  const l = parseCore(latest);
  const len = Math.max(c.length, l.length);
  for (let i = 0; i < len; i++) {
    const ci = c[i] ?? 0;
    const li = l[i] ?? 0;
    if (li > ci) return true;
    if (li < ci) return false;
  }

  // Numeric cores are equal — compare pre-release suffixes.
  // A version WITHOUT a pre-release suffix is newer than one WITH it.
  const cPre = current.includes('-') ? current.split('-').slice(1).join('-') : '';
  const lPre = latest.includes('-') ? latest.split('-').slice(1).join('-') : '';
  if (!cPre && lPre) return false; // current is release, latest is pre-release
  if (cPre && !lPre) return true; // current is pre-release, latest is release
  if (cPre && lPre) return lPre > cPre; // both pre-release: lexicographic

  return false; // fully equal
}
