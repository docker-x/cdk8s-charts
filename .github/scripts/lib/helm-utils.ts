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
 * Handles:
 *  - Optional `v` prefix (e.g. `v1.2.3` → `1.2.3`)
 *  - Pre-release suffixes (e.g. `1.2.3-alpha`) per semver spec: a version
 *    with a pre-release suffix is older than the same version without one
 *  - Numeric pre-release sub-segments (e.g. `rc.10` > `rc.2`)
 */
export function isNewer(current: string | undefined, latest: string): boolean {
  if (!current) return true;
  // Strip optional `v` prefix.
  const c = current.replace(/^v/, '');
  const l = latest.replace(/^v/, '');
  if (c === l) return false;

  // Split into numeric core and pre-release suffix.
  const cCore = c
    .split('-')[0]
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  const lCore = l
    .split('-')[0]
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  const len = Math.max(cCore.length, lCore.length);
  for (let i = 0; i < len; i++) {
    const ci = cCore[i] ?? 0;
    const li = lCore[i] ?? 0;
    if (li > ci) return true;
    if (li < ci) return false;
  }

  // Numeric cores are equal — compare pre-release suffixes.
  // A version WITHOUT a pre-release suffix is newer than one WITH it.
  const cPre = c.includes('-') ? c.split('-').slice(1).join('-') : '';
  const lPre = l.includes('-') ? l.split('-').slice(1).join('-') : '';
  if (!cPre && lPre) return false; // current is release, latest is pre-release
  if (cPre && !lPre) return true; // current is pre-release, latest is release
  if (cPre && lPre) {
    // Both pre-release: compare dot-separated sub-segments.
    // Numeric segments compared numerically, non-numeric lexicographically.
    const cParts = cPre.split('.');
    const lParts = lPre.split('.');
    const plen = Math.max(cParts.length, lParts.length);
    for (let i = 0; i < plen; i++) {
      const cp = cParts[i] ?? '';
      const lp = lParts[i] ?? '';
      const cn = Number.parseInt(cp, 10);
      const ln = Number.parseInt(lp, 10);
      if (!Number.isNaN(cn) && !Number.isNaN(ln)) {
        if (ln > cn) return true;
        if (ln < cn) return false;
      } else {
        if (lp > cp) return true;
        if (lp < cp) return false;
      }
    }
  }

  return false; // fully equal
}
