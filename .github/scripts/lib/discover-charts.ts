/**
 * Auto-discover Helm-wrapped charts in packages/charts/*.
 *
 * For each chart package, parses src/construct.ts to extract:
 *  - chart ref (OCI url or chart name) — from the first renderChart() call
 *  - repo url (for non-OCI charts) — from the `repo:` option
 *  - current pinned version — from DEFAULT_VERSION / DEFAULT_CHART_VERSION const
 *
 * Charts that do not call renderChart (custom constructs) are skipped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DiscoveredChart {
  /** Chart package directory name (e.g. "gitlab-runner"). */
  name: string;
  /** Helm chart ref: OCI url or chart name. */
  chart: string;
  /** Helm repository url for non-OCI charts; undefined for OCI charts. */
  repo?: string;
  /** Currently pinned version in the construct source. */
  currentVersion?: string;
  /** Path to the construct file the info was extracted from. */
  source: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CHARTS_DIR = join(REPO_ROOT, 'packages', 'charts');

const SYMBOL_RE =
  /(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*[\w<>[\]|, ]+)?\s*=\s*(['"`])([^'"`]+)\2/g;

/** Build a symbol table of `const NAME = 'value'` declarations. */
function buildSymbolTable(source: string): Map<string, string> {
  const symbols = new Map<string, string>();
  // Matches `const NAME = 'value'`, `export const NAME = "value"`,
  // template-literal delimited values (backticks), and optional type
  // annotations (e.g. `const NAME: string = 'value'`).
  // Uses a backreference (\2) to match the closing quote type so values
  // containing the other quote type (e.g. "It's fine") are captured fully.
  // Limitation: single-line only; multi-line declarations are not supported.
  for (const m of source.matchAll(SYMBOL_RE)) {
    symbols.set(m[1], m[3]);
  }
  return symbols;
}

/** Resolve a token: either a quoted literal or a symbol-table reference. */
function resolveToken(token: string, symbols: Map<string, string>): string | undefined {
  const trimmed = token.trim();
  const literalMatch = trimmed.match(/^['"`]([^'"`]+)['"`]$/);
  if (literalMatch) return literalMatch[1];
  if (symbols.has(trimmed)) return symbols.get(trimmed);
  return undefined;
}

/**
 * Extract the first argument of the first renderChart / renderChartOn call.
 * Handles `props.chart ?? 'x'`, `props.chart ?? CONST`, or a bare `CONST`.
 *
 * Limitation: captures until the first comma, so complex expressions
 * containing commas (e.g. function calls with multiple args) will break.
 * This is acceptable for the current construct patterns, which use
 * simple identifiers or `props.chart ?? CONST` fallbacks.
 */
function extractChartRef(source: string, symbols: Map<string, string>): string | undefined {
  // Match renderChart( or renderChartOn( then capture up to the first comma.
  const callRe = /render(?:Chart|ChartOn)\s*\(\s*([^,]+)/g;
  const m = callRe.exec(source);
  if (!m) return undefined;
  const arg = m[1].trim();
  // `props.chart ?? SOMETHING`
  const fallbackMatch = arg.match(/props\.chart\s*\?\?\s*(.+)/);
  if (fallbackMatch) {
    return resolveToken(fallbackMatch[1], symbols);
  }
  return resolveToken(arg, symbols);
}

/** Extract the repo url from `repo: ...` inside a renderChart options object. */
function extractRepo(source: string, symbols: Map<string, string>): string | undefined {
  // Constrain to the first renderChart/renderChartOn call's options object.
  // `[^)]*?` bounds the match to within the call's argument list (won't cross
  // the closing paren), preventing matches in later code or comments.
  const re =
    /render(?:Chart|ChartOn)\s*\([^)]*?repo:\s*(?:props\.repo\s*\?\?\s*)?(['"][^'"]+['"]|[A-Z_][A-Z0-9_]*)/g;
  const m = re.exec(source);
  if (!m) return undefined;
  return resolveToken(m[1], symbols);
}

/** Extract the pinned version from DEFAULT_VERSION / DEFAULT_CHART_VERSION. */
function extractCurrentVersion(symbols: Map<string, string>): string | undefined {
  return symbols.get('DEFAULT_VERSION') ?? symbols.get('DEFAULT_CHART_VERSION');
}

/** Discover all Helm-wrapped charts. */
export function discoverCharts(): DiscoveredChart[] {
  const discovered: DiscoveredChart[] = [];

  for (const dir of readdirSync(CHARTS_DIR)) {
    const pkgDir = join(CHARTS_DIR, dir);
    const construct = join(pkgDir, 'src', 'construct.ts');
    if (!statSync(pkgDir).isDirectory()) continue;
    let source: string;
    try {
      source = readFileSync(construct, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('renderChart')) continue;

    const symbols = buildSymbolTable(source);
    const chart = extractChartRef(source, symbols);
    if (!chart) {
      console.warn(`discover: ${dir} uses renderChart but chart ref could not be extracted`);
      continue;
    }
    const isOci = chart.startsWith('oci://');
    const repo = isOci ? undefined : extractRepo(source, symbols);
    const currentVersion = extractCurrentVersion(symbols);

    discovered.push({
      name: dir,
      chart,
      repo,
      currentVersion,
      source: construct,
    });
  }

  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}
