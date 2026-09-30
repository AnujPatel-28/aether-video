import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Core from '@aether/core';
import * as Tools from '@aether/tools';
import * as Verification from '@aether/verification';

const root = resolve('.');
type Manifest = { name: string; dependencies?: Record<string, string>; exports?: Record<string, { import: string; types: string }> };
const packages = new Map<string, { directory: string; manifest: Manifest }>();
for (const directory of ['core', 'media', 'workspace', 'tools', 'verification']) {
  const absolute = resolve(root, 'packages', directory);
  const manifest = JSON.parse(readFileSync(resolve(absolute, 'package.json'), 'utf8')) as Manifest;
  packages.set(manifest.name, { directory: absolute, manifest });
}

function imports(source: string): string[] {
  const file = ts.createSourceFile('boundary.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      assert.ok(expression && ts.isStringLiteral(expression), 'Nonliteral module loading is not permitted in domain contracts');
      result.push(expression.text);
    }
    if (ts.isImportTypeNode(node)) {
      assert.ok(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal), 'Type imports must be literal');
      result.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      assert.ok(argument && ts.isStringLiteral(argument), 'Nonliteral module loading is not permitted in domain contracts');
      result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

function assertPublicClosure(file: string, visited = new Set<string>()): void {
  if (visited.has(file)) return;
  visited.add(file);
  assert.notEqual(file, resolve(root, 'packages/verification/src/evaluator.ts'), 'Hidden evaluator module reached');
  const localPath = relative(resolve(root, 'packages'), file);
  assert.ok(localPath !== '..' && !localPath.startsWith('..' + sep) && !isAbsolute(localPath), 'Contract closure must stay inside package sources');
  assert.notEqual(extname(file), '.json', 'Agent contracts must not load hidden/data fixtures');
  for (const specifier of imports(readFileSync(file, 'utf8'))) {
    if (specifier.startsWith('.')) {
      assertPublicClosure(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')), visited);
    } else if (specifier.startsWith('@aether/')) {
      const parts = specifier.split('/');
      const name = parts.slice(0, 2).join('/');
      const packageEntry = packages.get(name);
      assert.ok(packageEntry, `Unknown package ${name}`);
      const subpath = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
      const entry = packageEntry.manifest.exports?.[subpath];
      assert.ok(entry, `Unknown package export ${specifier}`);
      assertPublicClosure(resolve(packageEntry.directory, entry.import.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')), visited);
    } else {
      assert.ok(specifier === 'zod' || specifier === 'node:crypto', `Unexpected dependency in a contract closure: ${specifier}`);
    }
  }
}

test('Core and all shared Tools source modules cannot transitively import hidden evaluator schemas or data', () => {
  for (const directory of ['core', 'tools']) {
    const source = resolve(root, 'packages', directory, 'src');
    for (const file of readdirSync(source).filter(file => file.endsWith('.ts'))) {
      assertPublicClosure(resolve(source, file));
    }
  }
  assertPublicClosure(resolve(root, 'packages/verification/src/index.ts'));
});

test('package dependency closure for Core/Tools never installs an evaluator package edge', () => {
  const visited = new Set<string>();
  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    assert.notEqual(name, '@aether/verification');
    const entry = packages.get(name);
    assert.ok(entry);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (dependency.startsWith('@aether/')) visit(dependency);
      else assert.equal(dependency, 'zod');
    }
  }
  visit('@aether/core'); visit('@aether/tools');
});

test('boundary checker covers re-exports, type imports and dynamic imports and rejects an evaluator reach', () => {
  assert.deepEqual(imports("import type { T } from './types.js'; export * from './public.js'; const hidden = import('@aether/verification/evaluator'); type Gold = import('@aether/verification/evaluator').EvaluationSpec;"), ['./types.js', './public.js', '@aether/verification/evaluator', '@aether/verification/evaluator']);
  assert.throws(() => imports('const value = import(variable);'));
  assert.throws(() => assertPublicClosure(resolve(root, 'packages/verification/src/evaluator.ts')), /Hidden evaluator/);
});

test('runtime exports separate visible tasks, AETHER representations and hidden evaluation', () => {
  for (const name of ['EvaluationSpecSchema', 'ExperimentConfigSchema', 'EditorialVerificationResultSchema', 'EditContractSchema', 'EditorialPlanSchema']) {
    assert.equal(name in Core, false, `Core must not export ${name}`);
    assert.equal(name in Tools, false, `Shared tools must not export ${name}`);
    assert.equal(name in Verification, false, `Public verification must not export ${name}`);
  }
  assert.deepEqual(Object.keys(Tools), ['TaskInstructionsSchema']);
  assert.deepEqual(Object.keys(Verification), ['MechanicalVerificationResultSchema']);
  for (const name of ['applyBatch', 'split', 'trim', 'move', 'undo', 'render', 'runExperiment']) {
    assert.equal(name in Core, false, `Milestones 2-6 must not be exposed: ${name}`);
  }
});

test('test runtime and declared Node/pnpm pins match the chosen foundation toolchain', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { engines: { node: string; pnpm: string }; packageManager: string };
  assert.equal(process.versions.node, manifest.engines.node);
  assert.equal(readFileSync(resolve(root, '.node-version'), 'utf8').trim(), manifest.engines.node);
  assert.equal(manifest.packageManager, `pnpm@${manifest.engines.pnpm}`);
});
