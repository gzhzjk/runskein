#!/usr/bin/env node
/**
 * Assert that the frozen surface and the code it describes say the same thing.
 *
 * `docs/engine-adapter-api.md` states the v1 contract by declaring it, and the
 * implementation declares it again in TypeScript. Both are authoritative to
 * somebody: a consumer reads the document as the promise and files a bug
 * against the code when they disagree. Nothing compared them, and two
 * disagreements had accumulated by the time this was written — the document
 * showed two of `TranscriptStore.digest`'s four overloads, so a reader believed
 * they had to narrow a result the implementation already narrowed for them, and
 * `UsageMapping` was named in the contract while no entry exported it, so an
 * adapter author could build the object but not name its type.
 *
 * **Why the compiler rather than a comparison.** Reading the two as text finds
 * twelve disagreements on a clean tree, every one of them the document inlining
 * what the code names — `'end_turn' | 'max_tokens' | …` for `StopReason`,
 * `Promise<TranscriptDigest | StructuredDigest>` for `Promise<DigestResult>`.
 * Those are a kindness to the reader, not drift, and a gate that reports them
 * is one nobody will keep. Handing the question to the type system removes all
 * twelve without a single special case, and takes indexed access, `Readonly<>`
 * and unions with it.
 *
 * So each declaration is lifted out of the page, renamed, and compiled beside
 * the real one, and compared on two axes.
 *
 * **Membership, by keys.** Assignability alone does not see a member appearing
 * or disappearing: every member of `Usage` is optional, so a field added to the
 * code and never documented is still assignable in both directions. Measured —
 * this script's first version passed that mutation, which is the exact drift
 * the whole check exists to catch. Comparing `keyof` both ways sees it.
 *
 *     type _keysFwd = keyof Doc_Usage extends keyof Usage ? true : { … };
 *     type _keysRev = keyof Usage extends keyof Doc_Usage ? true : { … };
 *
 * **Shape, by assignability.** Keys alone would not see a member's type change,
 * so the same declaration is asserted assignable both ways as well.
 *
 * Both directions on both axes, because they catch different failures. Forward
 * catches a document promising more than the code ships. Reverse catches a
 * document that has fallen behind — the direction `verify-quoted-code.mjs`
 * structurally cannot see, since a quotation stays true while the file grows
 * past it, and the reason that gate leaves these blocks alone.
 *
 * Every public export is aliased into scope before the lifted declarations, so
 * a reference inside one resolves to the real type. That has a second effect
 * worth keeping: a contract naming a type the entry does not export does not
 * compile, which is how the `UsageMapping` gap surfaced.
 *
 * The Chinese peer needs no separate pass — its `ts` blocks are byte-identical
 * to the English ones — but that identity is asserted rather than assumed,
 * because assuming it is how a translated copy last outlived its original.
 *
 * Usage: `node scripts/verify-api-surface.mjs` (part of `pnpm quality`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The pages that state a contract, and the entry a consumer reaches it through.
 * The entry is the consumer's, not the implementing package's: what the
 * document promises has to be importable by the person reading it.
 */
const CONTRACTS = [
  {
    doc: 'docs/engine-adapter-api.md',
    peer: 'docs/engine-adapter-api.zh-CN.md',
    entries: ['packages/runskein/src/index.ts'],
  },
  {
    // Two entries, because the page's declarations reach across both: a folded
    // event carries `TranscriptEvent` and the protocol's own content types from
    // `runskein`, and the folded shapes themselves from `runskein/fold`. A
    // consumer of this page has both imported.
    doc: 'docs/transcript-fold.md',
    peer: 'docs/transcript-fold.zh-CN.md',
    entries: ['packages/runskein/src/fold.ts', 'packages/runskein/src/index.ts'],
  },
];

const COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
};

/** Symbol flags that make a name usable as a type. */
const TYPE_MEANING =
  ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;

/**
 * The names an entry exports that can be used as types.
 *
 * Value exports are excluded deliberately: aliasing `createHub` as a type is
 * ten diagnostics of the checker's own making, which is what the first draft
 * of this script did.
 * @param entry - the entry file, relative to `from`.
 * @param scratch - a directory to write the probe into.
 * @param index - distinguishes probes when several entries are read.
 * @param from - the repository root to read from.
 * @returns exported names with type meaning.
 */
function exportedTypeNames(entry, scratch, index = 0, from = root) {
  const probe = join(scratch, `probe${index}.ts`);
  writeFileSync(
    probe,
    `import type * as R from '${join(from, entry).replace(/\.ts$/, '.js')}';\nexport type _ = R;\n`,
  );
  const program = ts.createProgram([probe], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const source = program.getSourceFiles().find((file) => file.fileName === join(from, entry));
  if (source === undefined) return undefined;
  const symbol = checker.getSymbolAtLocation(source);
  if (symbol === undefined) return undefined;
  return checker
    .getExportsOfModule(symbol)
    .filter((exported) => {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return (target.flags & TYPE_MEANING) !== 0;
    })
    .map((exported) => exported.getName());
}

/**
 * Every interface and type alias a page declares, renamed so it can be compiled
 * beside the real one.
 * @param markdown - the page's contents.
 * @returns the declaration names and their renamed source.
 */
function liftedDeclarations(markdown) {
  const names = [];
  let source = '';
  for (const [, block] of markdown.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const parsed = ts.createSourceFile('block.ts', block, ts.ScriptTarget.Latest, true);
    for (const node of parsed.statements) {
      if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
      const name = node.name.text;
      names.push(name);
      source +=
        node.getText(parsed).replace(new RegExp(`\\b(interface|type)\\s+${name}\\b`), `$1 Doc_${name}`) +
        '\n\n';
    }
  }
  return { names, source };
}

/**
 * Compare one page's declarations with the entry it says a consumer uses.
 * @param contract - the page, its peer and the entry.
 * @param from - the repository root to read from.
 * @returns the failures found and how many declarations were compared.
 */
function checkContract(contract, from = root) {
  const failures = [];
  const markdown = readFileSync(join(from, contract.doc), 'utf8');

  // Code is not translated, so the peer carries the same blocks. Asserting that
  // is what lets one compilation cover both pages.
  const blocksOf = (text) => [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map(([, body]) => body);
  const english = blocksOf(markdown);
  const translated = blocksOf(readFileSync(join(from, contract.peer), 'utf8'));
  if (english.length !== translated.length || english.some((block, i) => block !== translated[i])) {
    failures.push(
      `${contract.peer} does not carry the same ts blocks as ${contract.doc} — code is not ` +
        'translated, and this check covers the peer only while they are identical',
    );
  }

  const { names, source } = liftedDeclarations(markdown);
  const scratch = mkdtempSync(join(tmpdir(), 'runskein-api-surface-'));
  try {
    // The first entry is the one the page is about; later ones only widen what
    // its declarations may refer to. A name exported by both resolves to the
    // first, which is the page's own module.
    const seen = new Set();
    const imports = [];
    const aliasLines = [];
    for (const [index, entryPath] of contract.entries.entries()) {
      const exported = exportedTypeNames(entryPath, scratch, index, from);
      if (exported === undefined) {
        failures.push(`${entryPath} could not be read as a module — nothing was compared`);
        return { failures, compared: 0 };
      }
      imports.push(`import type * as R${index} from '${join(from, entryPath).replace(/\.ts$/, '.js')}';`);
      for (const name of exported) {
        if (seen.has(name)) continue;
        seen.add(name);
        aliasLines.push(`type ${name} = R${index}.${name};`);
      }
    }
    const aliases = aliasLines.join('\n');
    const assertions = names
      .map(
        (name) =>
          `type _shapeFwd_${name} = Doc_${name} extends ${name} ? true : { PAGE_PROMISES_A_SHAPE_THE_CODE_LACKS: '${name}' };\n` +
          `type _shapeRev_${name} = ${name} extends Doc_${name} ? true : { CODE_HAS_A_SHAPE_THE_PAGE_LACKS: '${name}' };\n` +
          `type _keysFwd_${name} = keyof Doc_${name} extends keyof ${name} ? true : { PAGE_NAMES_A_MEMBER_THE_CODE_LACKS: '${name}' };\n` +
          `type _keysRev_${name} = keyof ${name} extends keyof Doc_${name} ? true : { CODE_HAS_A_MEMBER_THE_PAGE_LACKS: '${name}' };\n` +
          `const _a_${name}: _shapeFwd_${name} = true;\nconst _b_${name}: _shapeRev_${name} = true;\n` +
          `const _c_${name}: _keysFwd_${name} = true;\nconst _d_${name}: _keysRev_${name} = true;`,
      )
      .join('\n');
    const file = join(scratch, 'surface.ts');
    writeFileSync(file, `${imports.join('\n')}\n${aliases}\n\n${source}\n${assertions}\n`);

    const program = ts.createProgram([file], COMPILER_OPTIONS);
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      if (diagnostic.file?.fileName !== file) continue;
      failures.push(`${contract.doc}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
    return { failures, compared: names.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Check every contract page against its entry.
 * @param contracts - the pages to check.
 * @param from - the repository root to read from.
 * @returns the failures found and how many declarations were compared.
 */
export function verifyApiSurface(contracts = CONTRACTS, from = root) {
  const failures = [];
  let compared = 0;
  for (const contract of contracts) {
    const result = checkContract(contract, from);
    failures.push(...result.failures);
    compared += result.compared;
  }
  return { failures, compared };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, compared } = verifyApiSurface();
  if (failures.length > 0) {
    console.error('API surface check failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`documented surface matches the code in ${compared} declaration(s)`);
}
