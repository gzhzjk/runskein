import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@agentclientprotocol/sdk');
const sourcePath = join(dirname(sdkEntry), 'schema', 'types.gen.d.ts');
const outputPath = resolve(import.meta.dirname, '../src/vocabulary.ts');
const sourceText = readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);

const publicNames = new Set([
  'Annotations',
  'ContentBlock',
  'ToolKind',
  'ToolCallLocation',
  'ToolCallStatus',
  'ToolCallContent',
  'ToolCallUpdate',
  'PlanEntry',
  'SessionUpdate',
  'PermissionOptionKind',
  'PermissionOption',
  'StopReason',
]);
const roots = new Set([...publicNames, 'McpServer']);
const declarations = new Map();
for (const statement of source.statements) {
  if (ts.isTypeAliasDeclaration(statement)) declarations.set(statement.name.text, statement);
}

const included = new Set();
function include(name) {
  if (included.has(name)) return;
  const declaration = declarations.get(name);
  if (!declaration) throw new Error(`ACP declaration '${name}' was not found`);
  included.add(name);
  const dependencies = new Set();
  function visit(node) {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      dependencies.add(node.typeName.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration.type);
  for (const dependency of dependencies) {
    if (declarations.has(dependency)) include(dependency);
  }
}
for (const root of roots) include(root);

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const body = [...included]
  .map((name) => declarations.get(name))
  .sort((a, b) => a.pos - b.pos)
  .map((node) => {
    const printed = printer.printNode(ts.EmitHint.Unspecified, node, source);
    return publicNames.has(node.name.text) ? printed : printed.replace(/^export type /, 'type ');
  })
  .join('\n\n');

const header = `/**
 * GENERATED from @agentclientprotocol/sdk's pinned ACP v1 schema.
 * Run \`pnpm --filter @runskein/core generate:vocabulary\` after SDK upgrades.
 * RunSkein owns and exports these declarations; core does not re-export SDK types.
 */
`;
const generated = `${header}\n${body}\n\nexport type McpServerConfig = McpServer;\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error('src/vocabulary.ts is stale; run generate:vocabulary');
  }
} else {
  writeFileSync(outputPath, generated, 'utf8');
}
