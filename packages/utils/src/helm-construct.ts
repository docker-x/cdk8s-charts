import { Helm } from 'cdk8s';
import { Construct } from 'constructs';
import type { DeepPartial } from './k8s-types';

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
  /** Chart-level value overrides (deep-merged into computed values). */
  values?: DeepPartial<V>;
}

/**
 * Base class for constructs that wrap a single Helm chart.
 *
 * Subclasses call `renderChart()` with computed values and a chart OCI ref.
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
  ): V {
    const values = overrides ? deepMerge(computed, overrides) : computed;

    new Helm(this, 'chart', {
      chart,
      releaseName,
      namespace,
      values,
    });

    return values;
  }
}
