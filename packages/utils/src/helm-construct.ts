import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Helm } from 'cdk8s';
import { Construct } from 'constructs';
import type { DeepPartial } from './k8s-types';

// ---------------------------------------------------------------------------
// Helm chart cache resolution
// ---------------------------------------------------------------------------

const HELM_CACHE_DIR = process.env.HELM_CACHE_HOME
  ? join(process.env.HELM_CACHE_HOME, 'repository')
  : join(process.env.HOME ?? '/root', '.cache', 'helm', 'repository');

// Restrict PATH to fixed system directories when shelling out to helm.
const HELM_PATH = '/usr/local/bin:/usr/bin:/bin';
const HELM_PULL_TIMEOUT_MS = Number(process.env.HELM_PULL_TIMEOUT_MS) || 300_000;

const ociPullCache = new Map<string, string>();
const ociPullTempDirs: string[] = [];
let ociPullCleanupRegistered = false;

function registerOciPullCleanup(): void {
  if (ociPullCleanupRegistered) return;
  ociPullCleanupRegistered = true;
  process.on('exit', () => {
    for (const dir of ociPullTempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on exit
      }
    }
  });
}

/**
 * Resolve an OCI chart reference to a local cached .tgz if available.
 * Falls back to the original reference when no cache hit.
 *
 * Set HELM_USE_CACHE=1 to force local cache usage (useful when OCI
 * registries are unreachable, e.g. WSL2 IPv6 issues).
 */
function resolveChart(chart: string, version?: string): { chart: string; fromCache: boolean } {
  if (process.env.HELM_USE_CACHE !== '1' || !existsSync(HELM_CACHE_DIR)) {
    return chart.startsWith('oci://')
      ? { chart: pullOciChart(chart, version), fromCache: true }
      : { chart, fromCache: false };
  }

  // Extract chart name: last segment for OCI URLs, or the name itself
  const chartName = chart.startsWith('oci://') ? chart.split('/').pop()! : chart;

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
    return chart.startsWith('oci://')
      ? { chart: pullOciChart(chart, version), fromCache: true }
      : { chart, fromCache: false };
  }

  // No version pinned: pick the latest cached version (lexicographic sort)
  const matches = files.filter((f) => f.startsWith(`${chartName}-`) && f.endsWith('.tgz')).sort();
  if (matches.length > 0) {
    const resolved = join(HELM_CACHE_DIR, matches[matches.length - 1]);
    console.log(`[helm-cache] ${chart} -> ${resolved}`);
    return { chart: resolved, fromCache: true };
  }

  return chart.startsWith('oci://')
    ? { chart: pullOciChart(chart, version), fromCache: true }
    : { chart, fromCache: false };
}

function pullOciChart(chart: string, version?: string): string {
  const cacheKey = `${chart}@${version ?? 'latest'}`;
  const cached = ociPullCache.get(cacheKey);
  if (cached) return cached;

  registerOciPullCleanup();

  const destination = mkdtempSync(join(tmpdir(), 'cdk8s-chart-'));
  ociPullTempDirs.push(destination);

  try {
    const args = ['pull', chart, '--destination', destination];
    if (version) args.push('--version', version);

    const result = spawnSync('helm', args, {
      encoding: 'utf8',
      timeout: HELM_PULL_TIMEOUT_MS,
      env: { ...process.env, PATH: HELM_PATH },
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(`Helm pull timed out after ${HELM_PULL_TIMEOUT_MS}ms for ${chart}`);
      }
      throw result.error;
    }
    if (result.status !== 0) throw new Error(result.stderr || `Unable to pull Helm chart ${chart}`);

    const archive = readdirSync(destination).find((file) => file.endsWith('.tgz'));
    if (!archive) throw new Error(`Helm did not produce a chart archive for ${chart}`);

    const resolved = join(destination, archive);
    ociPullCache.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    try {
      rmSync(destination, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on failure
    }
    const idx = ociPullTempDirs.indexOf(destination);
    if (idx !== -1) ociPullTempDirs.splice(idx, 1);
    throw err;
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

  /** Install a Helm chart under an explicit scope (for multi-chart constructs). */
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
