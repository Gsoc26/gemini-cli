/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript';

export const BASE_EVAL_HELPERS = [
  'evalTest',
  'appEvalTest',
  'componentEvalTest',
] as const;

export type BaseEvalHelper = (typeof BASE_EVAL_HELPERS)[number];
export type EvalHelperName = BaseEvalHelper | string;
export type EvalPolicy =
  | 'ALWAYS_PASSES'
  | 'USUALLY_PASSES'
  | 'USUALLY_FAILS'
  | 'unknown';

export interface EvalSourceLocation {
  line: number;
  column: number;
}

export interface EvalAnalysisDiagnostic {
  severity: 'warning';
  message: string;
  filePath: string;
  location: EvalSourceLocation;
}

export interface EvalToolReference {
  name: string;
  evidence: 'toolRequest.name' | 'setBreakpoint' | 'waitForPendingConfirmation';
  location: EvalSourceLocation;
}

export interface EvalCaseRecord {
  filePath: string;
  relativePath: string;
  helperName: EvalHelperName;
  baseHelperName: BaseEvalHelper | 'unknown';
  policy: EvalPolicy;
  name: string;
  suiteName?: string;
  suiteType?: string;
  timeout?: number;
  hasFiles: boolean;
  hasPrompt: boolean;
  tools: readonly EvalToolReference[];
  location: EvalSourceLocation;
}

export interface EvalFileAnalysis {
  filePath: string;
  relativePath: string;
  helpers: Record<string, BaseEvalHelper | 'unknown'>;
  cases: readonly EvalCaseRecord[];
  diagnostics: readonly EvalAnalysisDiagnostic[];
}

export interface AnalyzeEvalSourceOptions {
  filePath?: string;
  repoRoot?: string;
}

export interface EvalInventory {
  files: readonly EvalFileAnalysis[];
  cases: readonly EvalCaseRecord[];
  diagnostics: readonly EvalAnalysisDiagnostic[];
}

export interface AnalyzeEvalFilesOptions {
  repoRoot?: string;
}

export async function discoverEvalFiles(evalRoot = 'evals') {
  const results: string[] = [];

  async function visit(currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'logs') {
          await visit(entryPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.eval.ts')) {
        results.push(entryPath);
      }
    }
  }

  await visit(evalRoot);
  return results.sort(compareStrings);
}

export async function analyzeEvalFiles(
  filePaths: readonly string[],
  options: AnalyzeEvalFilesOptions = {},
): Promise<EvalInventory> {
  const files = await Promise.all(
    filePaths.map(async (filePath) =>
      analyzeEvalSource(await readFile(filePath, 'utf8'), {
        filePath,
        repoRoot: options.repoRoot,
      }),
    ),
  );

  files.sort((left, right) =>
    compareStrings(left.relativePath, right.relativePath),
  );

  const cases = files.flatMap((file) => file.cases).sort(compareEvalCases);
  const diagnostics = files
    .flatMap((file) => file.diagnostics)
    .sort(compareDiagnostics);

  return { files, cases, diagnostics };
}

export function analyzeEvalSource(
  sourceText: string,
  options: AnalyzeEvalSourceOptions = {},
): EvalFileAnalysis {
  const filePath = options.filePath ?? '<inline>';
  const relativePath = getRelativePath(filePath, options.repoRoot);
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const helpers = collectHelperMappings(sourceFile);
  const diagnostics: EvalAnalysisDiagnostic[] = [];
  const cases: EvalCaseRecord[] = [];

  collectEvalCalls(sourceFile, helpers, (callExpression, helperName) => {
    const args = callExpression.arguments;
    const policyArg = args[0];
    const evalCaseArg = args[1];
    const policy = policyArg ? getStringLiteralValue(policyArg) : undefined;
    const evalCase =
      evalCaseArg && ts.isObjectLiteralExpression(evalCaseArg)
        ? evalCaseArg
        : undefined;

    if (!policy || !isEvalPolicy(policy)) {
      diagnostics.push({
        severity: 'warning',
        message: `Could not statically resolve policy for ${helperName} call.`,
        filePath,
        location: getLocation(sourceFile, policyArg ?? callExpression),
      });
    }

    if (!evalCase) {
      diagnostics.push({
        severity: 'warning',
        message: `Could not statically resolve eval case object for ${helperName} call.`,
        filePath,
        location: getLocation(sourceFile, evalCaseArg ?? callExpression),
      });
      return;
    }

    const name = getStaticStringProperty(evalCase, 'name');
    if (!name) {
      diagnostics.push({
        severity: 'warning',
        message: `Could not statically resolve eval case name for ${helperName} call.`,
        filePath,
        location: getLocation(sourceFile, evalCase),
      });
    }

    cases.push({
      filePath,
      relativePath,
      helperName,
      baseHelperName: helpers[helperName] ?? 'unknown',
      policy: isEvalPolicy(policy) ? policy : 'unknown',
      name: name ?? '<unknown>',
      suiteName: getStaticStringProperty(evalCase, 'suiteName'),
      suiteType: getStaticStringProperty(evalCase, 'suiteType'),
      timeout: getStaticNumberProperty(evalCase, 'timeout'),
      hasFiles: hasProperty(evalCase, 'files'),
      hasPrompt: hasProperty(evalCase, 'prompt'),
      tools: collectToolReferences(sourceFile, evalCase),
      location: getLocation(sourceFile, callExpression),
    });
  });

  cases.sort(compareEvalCases);

  return {
    filePath,
    relativePath,
    helpers,
    cases,
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

function collectHelperMappings(
  sourceFile: ts.SourceFile,
): Record<string, BaseEvalHelper | 'unknown'> {
  const helpers: Record<string, BaseEvalHelper | 'unknown'> = {};
  for (const helper of BASE_EVAL_HELPERS) {
    helpers[helper] = helper;
  }

  for (const alias of collectImportedHelperAliases(sourceFile)) {
    helpers[alias.name] = alias.baseHelper;
  }

  let changed = true;
  while (changed) {
    changed = false;

    sourceFile.forEachChild((node) => {
      const name = getFunctionLikeBindingName(node);
      if (!name || helpers[name]) {
        return;
      }

      const baseHelper = findCalledHelper(node, helpers);
      if (
        baseHelper &&
        helpers[baseHelper] &&
        helpers[baseHelper] !== 'unknown'
      ) {
        helpers[name] = helpers[baseHelper];
        changed = true;
      }
    });
  }

  return helpers;
}

function collectImportedHelperAliases(sourceFile: ts.SourceFile) {
  const aliases: Array<{ name: string; baseHelper: BaseEvalHelper }> = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (isBaseEvalHelper(importedName)) {
        aliases.push({
          name: element.name.text,
          baseHelper: importedName,
        });
      }
    }
  }

  return aliases;
}

function collectEvalCalls(
  sourceFile: ts.SourceFile,
  helpers: Record<string, BaseEvalHelper | 'unknown'>,
  onCall: (callExpression: ts.CallExpression, helperName: string) => void,
) {
  const visit = (node: ts.Node) => {
    const wrapperName = getFunctionLikeBindingName(node);
    if (wrapperName && helpers[wrapperName] && !isBaseEvalHelper(wrapperName)) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const helperName = getCalledIdentifierName(node);
      if (helperName && helpers[helperName]) {
        onCall(node, helperName);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function findCalledHelper(
  node: ts.Node,
  helpers: Record<string, BaseEvalHelper | 'unknown'>,
): string | undefined {
  let found: string | undefined;

  const visit = (candidate: ts.Node) => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(candidate)) {
      const helperName = getCalledIdentifierName(candidate);
      if (helperName && helpers[helperName]) {
        found = helperName;
        return;
      }
    }
    ts.forEachChild(candidate, visit);
  };

  ts.forEachChild(node, visit);
  return found;
}

function collectToolReferences(
  sourceFile: ts.SourceFile,
  evalCase: ts.ObjectLiteralExpression,
): EvalToolReference[] {
  const tools: EvalToolReference[] = [];

  const addTool = (
    name: string | undefined,
    evidence: EvalToolReference['evidence'],
    node: ts.Node,
  ) => {
    if (!name) {
      return;
    }
    tools.push({
      name,
      evidence,
      location: getLocation(sourceFile, node),
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node)) {
      const leftTool = getToolRequestNameComparison(node.left, node.right);
      const rightTool = getToolRequestNameComparison(node.right, node.left);
      addTool(leftTool ?? rightTool, 'toolRequest.name', node);
    }

    if (ts.isCallExpression(node)) {
      const callName = getPropertyCallName(node);
      if (
        callName === 'setBreakpoint' ||
        callName === 'waitForPendingConfirmation'
      ) {
        for (const toolName of getStaticToolNamesFromExpression(
          node.arguments[0],
        )) {
          addTool(toolName, callName, node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(evalCase);
  return tools.sort(compareToolReferences);
}

function getToolRequestNameComparison(
  candidateNameExpression: ts.Expression,
  candidateValueExpression: ts.Expression,
) {
  if (!isToolRequestNameExpression(candidateNameExpression)) {
    return undefined;
  }
  return getStringLiteralValue(candidateValueExpression);
}

function isToolRequestNameExpression(expression: ts.Expression) {
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isPropertyAccessChain(expression)
  ) {
    return false;
  }
  return (
    expression.name.text === 'name' &&
    expression.expression.getText().includes('toolRequest')
  );
}

function getStaticToolNamesFromExpression(
  expression: ts.Expression | undefined,
): string[] {
  if (!expression) {
    return [];
  }

  const value = getStringLiteralValue(expression);
  if (value) {
    return [value];
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements
      .map((element) => getStringLiteralValue(element))
      .filter((element): element is string => Boolean(element));
  }

  return [];
}

function getFunctionLikeBindingName(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }

  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.length === 1
  ) {
    const [declaration] = node.declarationList.declarations;
    if (
      declaration &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.name.text;
    }
  }

  return undefined;
}

function getCalledIdentifierName(callExpression: ts.CallExpression) {
  return ts.isIdentifier(callExpression.expression)
    ? callExpression.expression.text
    : undefined;
}

function getPropertyCallName(callExpression: ts.CallExpression) {
  return ts.isPropertyAccessExpression(callExpression.expression)
    ? callExpression.expression.name.text
    : undefined;
}

function isBaseEvalHelper(name: string): name is BaseEvalHelper {
  return BASE_EVAL_HELPERS.includes(name as BaseEvalHelper);
}

function isEvalPolicy(policy: string | undefined): policy is EvalPolicy {
  return (
    policy === 'ALWAYS_PASSES' ||
    policy === 'USUALLY_PASSES' ||
    policy === 'USUALLY_FAILS'
  );
}

function hasProperty(objectLiteral: ts.ObjectLiteralExpression, name: string) {
  return Boolean(getPropertyAssignment(objectLiteral, name));
}

function getStaticStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
) {
  const assignment = getPropertyAssignment(objectLiteral, name);
  return assignment ? getStringLiteralValue(assignment.initializer) : undefined;
}

function getStaticNumberProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
) {
  const assignment = getPropertyAssignment(objectLiteral, name);
  if (!assignment) {
    return undefined;
  }
  const initializer = assignment.initializer;
  return ts.isNumericLiteral(initializer)
    ? Number(initializer.text)
    : undefined;
}

function getPropertyAssignment(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
) {
  return objectLiteral.properties.find((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const propertyName = property.name;
    return (
      (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) &&
      propertyName.text === name
    );
  }) as ts.PropertyAssignment | undefined;
}

function getStringLiteralValue(expression: ts.Expression | undefined) {
  if (!expression) {
    return undefined;
  }
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return undefined;
}

function getLocation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): EvalSourceLocation {
  const location = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    line: location.line + 1,
    column: location.character + 1,
  };
}

function getRelativePath(filePath: string, repoRoot: string | undefined) {
  if (filePath === '<inline>') {
    return filePath;
  }
  return repoRoot ? path.relative(repoRoot, filePath) : filePath;
}

function compareEvalCases(left: EvalCaseRecord, right: EvalCaseRecord) {
  return (
    compareStrings(left.relativePath, right.relativePath) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column ||
    compareStrings(left.name, right.name)
  );
}

function compareDiagnostics(
  left: EvalAnalysisDiagnostic,
  right: EvalAnalysisDiagnostic,
) {
  return (
    compareStrings(left.filePath, right.filePath) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column ||
    compareStrings(left.message, right.message)
  );
}

function compareToolReferences(
  left: EvalToolReference,
  right: EvalToolReference,
) {
  return (
    left.location.line - right.location.line ||
    left.location.column - right.location.column ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.evidence, right.evidence)
  );
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, 'en');
}
