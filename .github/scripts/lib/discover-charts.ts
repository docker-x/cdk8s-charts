/**
 * Auto-discover Helm-wrapped charts in packages/charts/*.
 *
 * For each chart package, parses src/construct.ts to extract:
 *  - chart ref (OCI url or chart name) — from the first renderChart() call
 *  - repo url (for non-OCI charts) — from the `repo:` option
 *  - current pinned version — from DEFAULT_VERSION / DEFAULT_CHART_VERSION const
 *
 * Uses the TypeScript Compiler API for reliable AST-based extraction
 * instead of regex, correctly handling multi-line declarations, type
 * annotations, and complex expressions.
 *
 * Charts that do not call renderChart (custom constructs) are skipped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

/** Map of const NAME = 'value' declarations extracted from the source. */
type ConstMap = Map<string, string>;

/**
 * Extract the string value from a TypeScript expression node.
 *
 * Limitations: does not handle string concatenation ('a' + 'b') or
 * template literals with substitutions (`${BASE}/chart`). The current
 * construct patterns use simple literals, identifiers, and ?? / ||
 * fallbacks, so these are not needed.
 */
function getStringValue(node: ts.Expression | undefined, consts: ConstMap): string | undefined {
  if (!node) return undefined;
  // String literal: 'foo' or "foo"
  if (ts.isStringLiteral(node)) return node.text;
  // Template literal with no substitutions: `foo`
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Identifier referencing a const: look up its initializer
  if (ts.isIdentifier(node)) {
    return consts.get(node.text);
  }
  // Binary expression: props.chart ?? 'fallback' or props.chart || 'fallback'
  // → try left first, then right. Use || for BarBarToken (empty string is
  // falsy) and ?? for QuestionQuestionToken (only null/undefined is falsy).
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      const left = getStringValue(node.left, consts);
      return kind === ts.SyntaxKind.BarBarToken
        ? left || getStringValue(node.right, consts)
        : (left ?? getStringValue(node.right, consts));
    }
  }
  return undefined;
}

/** Collect all top-level const declarations with string-like initializers. */
function collectConstDeclarations(sourceFile: ts.SourceFile): ConstMap {
  const consts: ConstMap = new Map();
  for (const stmt of sourceFile.statements) {
    // Handle `export const NAME = 'value'` and `const NAME = 'value'`
    let declList: ts.VariableDeclarationList | undefined;
    if (ts.isVariableStatement(stmt)) {
      declList = stmt.declarationList;
    }
    if (!declList) continue;
    for (const decl of declList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const value = getStringValue(decl.initializer, consts);
      if (value !== undefined) {
        consts.set(decl.name.text, value);
      }
    }
  }
  return consts;
}

/** Get the function name from a call expression (handles this.foo() and foo()). */
function getCallName(call: ts.CallExpression): string | undefined {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** Find the first renderChart() call, preferring renderChart over renderChartOn. */
function findRenderChartCall(sourceFile: ts.SourceFile): ts.CallExpression | undefined {
  let renderChartCall: ts.CallExpression | undefined;
  let renderChartOnCall: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (renderChartCall) return;
    const name = ts.isCallExpression(node) ? getCallName(node) : undefined;
    if (name === 'renderChart') {
      renderChartCall = node;
      return;
    }
    if (!renderChartOnCall && name === 'renderChartOn') {
      renderChartOnCall = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return renderChartCall ?? renderChartOnCall;
}

/** Extract the chart ref from the correct argument of a renderChart call. */
function extractChartRef(call: ts.CallExpression, consts: ConstMap): string | undefined {
  // renderChart(chart, ...) → arg 0 is chart
  // renderChartOn(scope, chart, ...) → arg 1 is chart
  const name = getCallName(call);
  const argIndex = name === 'renderChartOn' ? 1 : 0;
  const arg = call.arguments[argIndex];
  return getStringValue(arg, consts);
}

/**
 * Extract the repo url from the options object of a renderChart call.
 *
 * Limitation: only works with inline object literals. If options are
 * passed as a variable (e.g. `const opts = { repo: '...' }; renderChart(..., opts)`),
 * the repo URL cannot be extracted. All current constructs use inline
 * object literals for the options argument.
 */
function extractRepo(call: ts.CallExpression, consts: ConstMap): string | undefined {
  // renderChart(chart, id, namespace, computed, overrides, options)
  // The options object is the last argument containing `repo:` and `version:`
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      // Support both identifier keys ({ repo: ... }) and string literal keys ({ 'repo': ... })
      let keyName: string | undefined;
      if (ts.isIdentifier(prop.name)) keyName = prop.name.text;
      else if (ts.isStringLiteral(prop.name)) keyName = prop.name.text;
      if (keyName !== 'repo') continue;
      // repo: props.repo ?? 'url' or repo: 'url' or repo: CONST
      return getStringValue(prop.initializer, consts);
    }
  }
  return undefined;
}

/** Extract the pinned version from DEFAULT_VERSION / DEFAULT_CHART_VERSION. */
function extractCurrentVersion(consts: ConstMap): string | undefined {
  return consts.get('DEFAULT_VERSION') ?? consts.get('DEFAULT_CHART_VERSION');
}

/** Parse a TypeScript source file. */
function parseSource(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

/** Discover all Helm-wrapped charts. */
export function discoverCharts(): DiscoveredChart[] {
  const discovered: DiscoveredChart[] = [];

  for (const dir of readdirSync(CHARTS_DIR)) {
    const pkgDir = join(CHARTS_DIR, dir);
    const construct = join(pkgDir, 'src', 'construct.ts');
    if (!statSync(pkgDir).isDirectory()) continue;
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = parseSource(construct);
    } catch {
      continue;
    }

    const consts = collectConstDeclarations(sourceFile);
    const call = findRenderChartCall(sourceFile);
    if (!call) continue;

    const chart = extractChartRef(call, consts);
    if (!chart) {
      console.warn(`discover: ${dir} uses renderChart but chart ref could not be extracted`);
      continue;
    }
    const isOci = chart.startsWith('oci://');
    const repo = isOci ? undefined : extractRepo(call, consts);
    const currentVersion = extractCurrentVersion(consts);

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
