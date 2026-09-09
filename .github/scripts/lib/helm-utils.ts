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
 * Parse a version string, returning a SemVer or null.
 * Uses semver.parse first (preserves pre-release), then falls back to
 * semver.coerce only for partial versions like "1.0" or "1.2".
 * Guards against coercing arbitrary digit-bearing strings like "latest-2024".
 */
function parseVersion(v: string): semver.SemVer | null {
  const parsed = semver.parse(v);
  if (parsed) return parsed;
  // Only coerce strings that look like partial versions (optional v prefix, digits and dots only)
  if (/^v?[\d.]+$/.test(v)) return semver.coerce(v);
  return null;
}

/**
 * Compare two semver-ish versions. Returns true when `latest` is newer
 * than `current`.
 *
 * Uses the `semver` package for full SemVer 2.0.0 compliance, including
 * pre-release precedence and optional `v` prefix handling.
 */
export function isNewer(current: string | undefined, latest: string): boolean {
  if (!current) return true;
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  return semver.gt(l, c);
}
