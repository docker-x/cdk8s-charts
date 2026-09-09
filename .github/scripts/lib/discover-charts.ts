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

/** Extract the string value from a TypeScript expression node. */
function getStringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  // String literal: 'foo' or "foo"
  if (ts.isStringLiteral(node)) return node.text;
  // Template literal with no substitutions: `foo`
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Identifier referencing a const: look up its initializer
  if (ts.isIdentifier(node)) {
    return CONST_VALUES.get(node.text);
  }
  // Binary expression: props.chart ?? 'fallback' → return the right side
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return getStringValue(node.right);
  }
  return undefined;
}

/** Map of const NAME = 'value' declarations extracted from the source. */
const CONST_VALUES = new Map<string, string>();

/** Collect all top-level const declarations with string-like initializers. */
function collectConstDeclarations(sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    // Handle `export const NAME = 'value'` and `const NAME = 'value'`
    let declList: ts.VariableDeclarationList | undefined;
    if (ts.isVariableStatement(stmt)) {
      declList = stmt.declarationList;
    }
    if (!declList) continue;
    for (const decl of declList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const value = getStringValue(decl.initializer);
      if (value !== undefined) {
        CONST_VALUES.set(decl.name.text, value);
      }
    }
  }
}

/** Find the first renderChart() or renderChartOn() call expression. */
function findRenderChartCall(sourceFile: ts.SourceFile): ts.CallExpression | undefined {
  let result: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (result) return;
    if (ts.isCallExpression(node)) {
      // Handle both renderChart(...) and this.renderChart(...)
      const expr = node.expression;
      let name: string | undefined;
      if (ts.isIdentifier(expr)) name = expr.text;
      else if (ts.isPropertyAccessExpression(expr)) name = expr.name.text;
      if (name === 'renderChart' || name === 'renderChartOn') {
        result = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

/** Extract the chart ref from the first argument of a renderChart call. */
function extractChartRef(call: ts.CallExpression): string | undefined {
  const arg = call.arguments[0];
  return getStringValue(arg);
}

/** Extract the repo url from the options object (3rd arg) of a renderChart call. */
function extractRepo(call: ts.CallExpression): string | undefined {
  // renderChart(chart, id, namespace, computed, overrides, options)
  // The options object is the last argument containing `repo:` and `version:`
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (!ts.isIdentifier(prop.name) || prop.name.text !== 'repo') continue;
      // repo: props.repo ?? 'url' or repo: 'url' or repo: CONST
      return getStringValue(prop.initializer);
    }
  }
  return undefined;
}

/** Extract the pinned version from DEFAULT_VERSION / DEFAULT_CHART_VERSION. */
function extractCurrentVersion(): string | undefined {
  return CONST_VALUES.get('DEFAULT_VERSION') ?? CONST_VALUES.get('DEFAULT_CHART_VERSION');
}

/** Parse a TypeScript source file. */
function parseSource(filePath: string): ts.SourceFile | undefined {
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
      sourceFile = parseSource(construct) as ts.SourceFile;
    } catch {
      continue;
    }

    // Reset const map per file
    CONST_VALUES.clear();
    collectConstDeclarations(sourceFile);

    const call = findRenderChartCall(sourceFile);
    if (!call) continue;

    const chart = extractChartRef(call);
    if (!chart) {
      console.warn(`discover: ${dir} uses renderChart but chart ref could not be extracted`);
      continue;
    }
    const isOci = chart.startsWith('oci://');
    const repo = isOci ? undefined : extractRepo(call);
    const currentVersion = extractCurrentVersion();

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
