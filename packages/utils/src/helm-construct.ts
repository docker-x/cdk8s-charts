import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Helm } from 'cdk8s';
import { Construct } from 'constructs';
import type { DeepPartial } from './k8s-types';

// ---------------------------------------------------------------------------
// Helm chart cache resolution
// ---------------------------------------------------------------------------

const HELM_CACHE_DIR = process.env.HELM_CACHE_HOME
  ? join(process.env.HELM_CACHE_HOME, 'repository')
  : join(process.env.HOME ?? '/root', '.cache', 'helm', 'repository');

let ociCacheDir: string | undefined;
const ociPullCache = new Map<string, string>();

function getOciCacheDir(): string {
  if (!ociCacheDir) {
    ociCacheDir = process.env.HELM_OCI_CACHE_DIR
      ? process.env.HELM_OCI_CACHE_DIR
      : mkdtempSync(join(tmpdir(), 'cdk8s-oci-'));
    if (!existsSync(ociCacheDir)) {
      mkdirSync(ociCacheDir, { recursive: true });
    }
    if (!process.env.HELM_OCI_CACHE_DIR) {
      const dir = ociCacheDir;
      process.once('exit', () => {
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {}
        }
      });
    }
  }
  return ociCacheDir;
}

/**
 * Resolve a chart reference to a local cached .tgz if available.
 * OCI charts are pulled into a temporary local cache when no cache hit,
 * unless HELM_OCI_PULL=0. Non-OCI repo charts are returned as-is so Helm
 * fetches them from the repository configured via --repo.
 *
 * Set HELM_USE_CACHE=1 to force local cache usage (useful when OCI
 * registries are unreachable, e.g. WSL2 IPv6 issues).
 * Set HELM_OCI_PULL=0 to skip the OCI fallback pull and pass the
 * original OCI reference to cdk8s Helm.
 * Set HELM_OCI_PULL_TIMEOUT to change the pull timeout in ms (default 60000).
 * Set HELM_OCI_CACHE_DIR to use a persistent cache directory; otherwise a
 * process-scratch directory is created and removed on exit.
 * Set HELM_OCI_EXECUTABLE to an absolute path to the helm binary
 * (default: /usr/local/bin/helm, /usr/bin/helm, /bin/helm).
 */
function resolveChart(chart: string, version?: string): { chart: string; fromCache: boolean } {
  if (process.env.HELM_USE_CACHE !== '1' || !existsSync(HELM_CACHE_DIR)) {
    return resolveOciChart(chart, version);
  }

  // Extract chart name: last segment for OCI URLs, or the name itself
  const chartName = chart.startsWith('oci://') ? (chart.split('/').pop() ?? chart) : chart;

  const files = readdirSync(HELM_CACHE_DIR);

  // If version is pinned, look for exact match
  if (version) {
    const exact = `${chartName}-${version}.tgz`;
    if (files.includes(exact)) {
      const resolved = join(HELM_CACHE_DIR, exact);
      console.log(`[helm-cache] ${chart}@${version} -> ${resolved}`);
      return { chart: resolved, fromCache: true };
    }
    // Exact pinned version is not cached. Pull it locally first so Helm's OCI
    // status lines cannot become part of the rendered Kubernetes YAML.
    return resolveOciChart(chart, version);
  }

  // No version pinned: pick the latest cached version (lexicographic sort)
  const matches = files.filter((f) => f.startsWith(`${chartName}-`) && f.endsWith('.tgz')).sort();
  if (matches.length > 0) {
    const resolved = join(HELM_CACHE_DIR, matches[matches.length - 1]);
    console.log(`[helm-cache] ${chart} -> ${resolved}`);
    return { chart: resolved, fromCache: true };
  }

  return resolveOciChart(chart, version);
}

function resolveOciChart(chart: string, version?: string): { chart: string; fromCache: boolean } {
  if (!chart.startsWith('oci://')) {
    return { chart, fromCache: false };
  }
  if (process.env.HELM_OCI_PULL === '0') {
    return { chart, fromCache: false };
  }
  return { chart: pullOciChart(chart, version), fromCache: true };
}

function resolveHelmExecutable(): string {
  if (process.env.HELM_OCI_EXECUTABLE) {
    if (!isAbsolute(process.env.HELM_OCI_EXECUTABLE)) {
      throw new TypeError(
        `HELM_OCI_EXECUTABLE must be an absolute path, got ${process.env.HELM_OCI_EXECUTABLE}`,
      );
    }
    return process.env.HELM_OCI_EXECUTABLE;
  }
  for (const p of ['/usr/local/bin/helm', '/usr/bin/helm', '/bin/helm']) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'helm executable not found in /usr/local/bin, /usr/bin, or /bin. Set HELM_OCI_EXECUTABLE to an absolute path.',
  );
}

function pullOciChart(chart: string, version?: string): string {
  const key = `${chart}@${version ?? 'latest'}`;
  const cached = ociPullCache.get(key);
  if (cached) return cached;

  const cacheDir = getOciCacheDir();
  const destination = mkdtempSync(join(tmpdir(), 'cdk8s-oci-pull-'));
  const args = ['pull', chart, '--destination', destination];
  if (version) args.push('--version', version);

  const timeout = Number(process.env.HELM_OCI_PULL_TIMEOUT ?? '60000');
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(
      `HELM_OCI_PULL_TIMEOUT must be a positive integer, got ${process.env.HELM_OCI_PULL_TIMEOUT}`,
    );
  }
  try {
    const result = spawnSync(resolveHelmExecutable(), args, { encoding: 'utf8', timeout });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(
          `Helm pull timed out after ${timeout}ms for ${chart}: ${result.error.message}`,
        );
      }
      throw result.error;
    }
    if (result.signal) {
      throw new Error(
        `Helm pull terminated (${result.signal}) after ${timeout}ms for ${chart}: ${result.stderr || ''}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || `Unable to pull Helm chart ${chart}`);
    }

    const archive = readdirSync(destination).find((file) => file.endsWith('.tgz'));
    if (!archive) throw new Error(`Helm did not produce a chart archive for ${chart}`);

    const safeChart = chart.replace(/^oci:\/\//, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cacheName = `${safeChart}-${version ?? 'latest'}.tgz`;
    const cachePath = join(cacheDir, cacheName);
    copyFileSync(join(destination, archive), cachePath);
    ociPullCache.set(key, cachePath);
    return cachePath;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/** Recursively merge b into a (b wins on conflicts, arrays replaced). */
export function deepMerge<T extends Record<string, any>>(a: T, b: DeepPartial<T>): T {
  const out = { ...a } as Record<string, any>;
  for (const key of Object.keys(b)) {
    const bVal = (b as Record<string, any>)[key];
    if (
      bVal !== undefined &&
      bVal !== null &&
      typeof bVal === 'object' &&
      !Array.isArray(bVal) &&
      out[key] !== null &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], bVal);
    } else if (bVal !== undefined) {
      out[key] = bVal;
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Base Helm construct
// ---------------------------------------------------------------------------

/** Props for Helm construct with optional value overrides. */
export interface HelmConstructProps<V> {
  namespace: string;
  /** Helm chart ref. For OCI charts this is the full oci:// URL; for repo charts this is the chart name. */
  chart?: string;
  /** Helm repository URL for non-OCI charts. */
  repo?: string;
  /** Optional Helm chart version pin. Omit to let Helm resolve the latest chart. */
  version?: string;
  /** Chart-level value overrides (deep-merged into computed values). */
  values?: DeepPartial<V>;
}

/**
 * Base class for constructs that wrap a single Helm chart.
 *
 * Subclasses call `renderChart()` with computed values and a chart ref.
 * The base handles deep-merging `props.values` overrides and instantiating
 * the `Helm` construct.
 *
 * Also provides `flattenToEnv()` for subclasses that need to convert nested
 * config objects into flat UPPER_SNAKE_CASE env var maps.
 */
export abstract class HelmConstruct<V extends Record<string, any>> extends Construct {
  /**
   * Recursively flatten a nested object to UPPER_SNAKE_CASE keys.
   *
   * Example:
   *   this.flattenToEnv({ llm: { provider: 'openai' } }, 'HINDSIGHT_API')
   *   -> { HINDSIGHT_API_LLM_PROVIDER: 'openai' }
   *
   * @param obj - The object to flatten
   * @param prefix - The prefix for env var keys
   * @returns Flattened object with UPPER_SNAKE_CASE keys
   */
  protected flattenToEnv(obj: Record<string, unknown>, prefix: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (val === undefined || val === null) continue;
      const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
      if (typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(result, this.flattenToEnv(val as Record<string, unknown>, envKey));
      } else {
        result[envKey] = String(val);
      }
    }
    return result;
  }

  /**
   * Merge computed values with user overrides and install the Helm chart.
   * Returns the final merged values for post-processing (e.g. reading ports).
   *
   * @param chart - Helm chart reference (OCI or local)
   * @param releaseName - Helm release name
   * @param namespace - Kubernetes namespace
   * @param computed - Computed Helm values
   * @param overrides - User-provided value overrides
   * @param options - Additional options (helm flags, repo, version)
   * @returns Final merged values
   */
  protected renderChart(
    chart: string,
    releaseName: string,
    namespace: string,
    computed: V,
    overrides?: DeepPartial<V>,
    options?: { helmFlags?: string[]; repo?: string; version?: string },
  ): V {
    return this.renderChartOn(this, chart, releaseName, namespace, computed, overrides, options);
  }

  /**
   * Install a Helm chart under an explicit scope (for multi-chart constructs).
   *
   * @param scope - Construct scope for the Helm chart
   * @param chart - Helm chart reference (OCI or local)
   * @param releaseName - Helm release name
   * @param namespace - Kubernetes namespace
   * @param computed - Computed Helm values
   * @param overrides - User-provided value overrides
   * @param options - Additional options (helm flags, repo, version)
   * @returns Final merged values
   */
  protected renderChartOn<U extends Record<string, any>>(
    scope: Construct,
    chart: string,
    releaseName: string,
    namespace: string,
    computed: U,
    overrides?: DeepPartial<U>,
    options?: { helmFlags?: string[]; repo?: string; version?: string },
  ): U {
    const values = overrides ? deepMerge(computed, overrides) : computed;

    const { chart: resolved, fromCache } = resolveChart(chart, options?.version);
    const isOci = chart.startsWith('oci://');
    const repoFlags = options?.repo && !isOci ? ['--repo', options.repo] : [];
    const helmFlags = [...repoFlags, ...(options?.helmFlags ?? [])];
    const flags = fromCache
      ? helmFlags.filter((f, i, arr) => {
          if (f === '--repo' || f.startsWith('--repo=')) return false;
          if (i > 0 && arr[i - 1] === '--repo') return false;
          return true;
        })
      : helmFlags;

    new Helm(scope, 'chart', {
      chart: resolved,
      releaseName,
      namespace,
      values,
      ...(flags?.length ? { helmFlags: flags } : {}),
      ...(!fromCache && options?.version ? { version: options.version } : {}),
    });

    return values;
  }
}
