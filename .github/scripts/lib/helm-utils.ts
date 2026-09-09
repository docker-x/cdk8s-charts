/**
 * Shared Helm utilities for chart update scripts.
 *
 * Extracted to avoid duplication between check-chart-updates.ts (CI)
 * and check-chart-updates-local.ts (local report).
 */

import { execFileSync } from 'node:child_process';
import semver from 'semver';

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
 * Uses the `semver` package for full SemVer 2.0.0 compliance, including
 * pre-release precedence and optional `v` prefix handling.
 * `semver.parse` is tried first (preserves pre-release), falling back
 * to `semver.coerce` for partial versions like `1.0`.
 */
export function isNewer(current: string | undefined, latest: string): boolean {
  if (!current) return true;
  const c = semver.parse(current) ?? semver.coerce(current);
  const l = semver.parse(latest) ?? semver.coerce(latest);
  if (!c || !l) return current !== latest;
  return semver.gt(l, c);
}
