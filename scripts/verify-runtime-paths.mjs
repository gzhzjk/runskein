#!/usr/bin/env node
/**
 * Assert that published code resolves no path at run time except to a file
 * this repository has declared as a runtime asset.
 *
 * Three defects have shipped from one shape: code that reaches something by
 * path, published in a layout where that path is only true of this repository's
 * own tree. The supervisor asset that was never copied, and the
 * `../../package.json` read for the client version that broke every bundling
 * consumer. (The third, a shim's bare package import, is a different mechanism
 * and belongs to the import-boundary check in `quality.mjs`.)
 *
 * `build-assets.mjs` already asks whether a referenced path exists here. That
 * is a different question, and it is the reassuring one: a path that resolves
 * in this tree is exactly the path that ships and then resolves to something
 * else — or to nothing — in a consumer's build directory.
 *
 * So the rule is a declaration rather than an inference. Every path a built
 * file resolves against its own location must appear in `runtime-assets.json`,
 * and every entry there must exist and be inside its package's published
 * `files`. Deriving the answer from `files` alone was tried and rejected in
 * review: `["dist", "package.json"]` and `["dist/index.js", "package.json"]`
 * pack the same bytes, and only one of them would have refused the manifest
 * read — a guard whose verdict turns on how a manifest is spelled is not one.
 *
 * The declaration is also what keeps the exemptions honest. `adapters/pi`
 * spawns its shim by path and reads a permission gate beside it; both are
 * named in that file, so this script never learns the word "pi" and there is
 * no blanket opt-out to reach for at the first inconvenience.
 *
 * What it cannot see is a path assembled from something that is not a literal —
 * a name from configuration, a string built by concatenation. That limit is
 * real and stated; the bundling case in `verify-runtime-paths.test.mjs` is what
 * tests the property itself rather than its spelling.
 *
 * Usage: `node scripts/verify-runtime-paths.mjs` from the repository root,
 * after `pnpm -r build`. A publishable package with no built output is an
 * error: nothing to scan must not read as nothing wrong.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import ts from 'typescript';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories a workspace package can live in. */
const PACKAGE_ROOTS = ['packages', 'adapters'];

/** Extensions whose files are code to scan rather than assets to resolve to. */
const SCANNED = ['.js', '.mjs', '.cjs'];

/**
 * Every file under `dir`, recursively.
 * @param dir - the directory to walk; a missing one yields nothing.
 * @returns absolute paths.
 */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/**
 * The workspace packages that publish, with what each of them ships.
 * @returns one entry per publishable package.
 */
export function publishablePackages() {
  const found = [];
  for (const group of PACKAGE_ROOTS) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.private === true) continue;
      found.push({ name: manifest.name, dir, files: manifest.files ?? [] });
    }
  }
  return found;
}

/**
 * Whether `child` is inside `parent` (or is it).
 * @param parent - the containing directory.
 * @param child - the path to test.
 * @returns true when child does not escape parent.
 */
function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The module exports this understands, by the module they come from.
 *
 * Identity comes from the binding, not the spelling. `import { join as
 * pathJoin }` is `join`, and a local function called `join` is not — the
 * previous shape had both backwards, reporting `Promise.resolve(dir, 'helper')`
 * as a path and missing `pathJoin` entirely.
 */
const MODULE_EXPORTS = {
  'node:path': ['join', 'resolve', 'normalize', 'dirname'],
  path: ['join', 'resolve', 'normalize', 'dirname'],
  'node:url': ['fileURLToPath', 'pathToFileURL'],
  url: ['fileURLToPath', 'pathToFileURL'],
  'node:module': ['createRequire'],
  module: ['createRequire'],
};

/**
 * What a file's imports and requires bind, so a call can be identified.
 * @param file - the parsed source file.
 * @returns `{ names, namespaces }`: local name → export name, and local name →
 *   the module it is a namespace for.
 */
function collectBindings(file) {
  const names = new Map();
  const namespaces = new Map();
  const remember = (moduleName, binding) => {
    const exports = MODULE_EXPORTS[moduleName];
    if (exports === undefined) return;
    if (binding.kind === 'namespace') namespaces.set(binding.local, moduleName);
    else if (exports.includes(binding.exported)) names.set(binding.local, binding.exported);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name !== undefined) {
        remember(moduleName, { kind: 'namespace', local: clause.name.text });
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        remember(moduleName, { kind: 'namespace', local: bindings.name.text });
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          remember(moduleName, {
            kind: 'named',
            local: element.name.text,
            exported: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
    // `const { join } = require('node:path')`, and `const path = require(…)`.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      stringOf(node.initializer.arguments[0]) !== undefined
    ) {
      const moduleName = stringOf(node.initializer.arguments[0]);
      if (ts.isIdentifier(node.name)) {
        remember(moduleName, { kind: 'namespace', local: node.name.text });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const exported = element.propertyName ?? element.name;
          if (!ts.isIdentifier(exported)) continue;
          remember(moduleName, { kind: 'named', local: element.name.text, exported: exported.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { names, namespaces };
}

/**
 * Whether a name is bound locally, and so is not the global it looks like.
 * @param env - the environment.
 * @param name - the identifier.
 * @returns true when some enclosing scope declares it.
 */
function isShadowed(env, name) {
  for (let scope = env; scope !== undefined; scope = scope.parent) {
    if (scope.vars.has(name)) return true;
  }
  return false;
}

/**
 * The operation a callee names, in this file's bindings.
 * @param callee - the called expression.
 * @param bindings - what the file imported.
 * @param env - the environment, for shadowing.
 * @returns a canonical name, or undefined when this is not a path operation.
 */
function canonicalCallee(callee, bindings, env) {
  if (ts.isIdentifier(callee)) {
    if (isShadowed(env, callee.text)) return undefined;
    if (bindings.names.has(callee.text)) return bindings.names.get(callee.text);
    // The globals a module does not import: `require` in CommonJS, and `URL`.
    if (callee.text === 'require') return 'require';
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const object = callee.expression.text;
    if (isShadowed(env, object)) return undefined;
    const moduleName = bindings.namespaces.get(object);
    if (moduleName !== undefined && MODULE_EXPORTS[moduleName].includes(callee.name.text)) {
      return callee.name.text;
    }
    // `require.resolve('./x')` resolves exactly like `require('./x')`.
    if (object === 'require' && callee.name.text === 'resolve') return 'require';
    return undefined;
  }
  // `import.meta.resolve('./x')`.
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isMetaProperty(callee.expression) &&
    callee.name.text === 'resolve'
  ) {
    return 'require';
  }
  return undefined;
}

/**
 * Join path segments the way a POSIX path joins, keeping the result relative.
 * @param segments - the pieces, any of which may be empty.
 * @returns the normalised relative path; `''` is the file's own directory.
 */
function joinRelative(segments) {
  const out = [];
  for (const segment of segments.join('/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * The directory part of a relative path.
 * @param path - a relative path, `''` meaning the file's own directory.
 * @returns the directory containing it.
 */
function parentOf(path) {
  const at = path.lastIndexOf('/');
  if (at === -1) return path === '' || path === '..' ? path : '';
  return path.slice(0, at);
}

/**
 * A lexical environment, so a name can be owned by the scope that declared it.
 *
 * A copied set was tried and could not express this: `let here;` in one scope
 * assigned inside a block updates the outer binding, and copying loses that on
 * the way out. Declarations create here; assignments find the owner.
 * @param parent - the enclosing environment, or undefined at the top.
 * @returns the environment.
 */
function newEnv(parent, barrier = false) {
  return { vars: new Map(), parent, barrier };
}

/**
 * Look a name up through the environment chain.
 * @param env - the innermost environment.
 * @param name - the identifier.
 * @returns its recorded location, or undefined when it holds none.
 */
function lookup(env, name) {
  for (let scope = env; scope !== undefined; scope = scope.parent) {
    if (scope.vars.has(name)) return scope.vars.get(name);
  }
  return undefined;
}

/**
 * Record a name declared in this environment.
 * @param env - the environment the declaration is in.
 * @param name - the identifier.
 * @param value - its location, or undefined when it holds none.
 */
function declare(env, name, value) {
  env.vars.set(name, value);
}

/**
 * Record an assignment against whichever environment owns the name.
 * @param env - the innermost environment.
 * @param name - the identifier.
 * @param value - its location, or undefined when it holds none.
 */
function assign(env, name, value) {
  for (let scope = env; scope !== undefined; scope = scope.parent) {
    if (scope.vars.has(name)) {
      scope.vars.set(name, value);
      return;
    }
    // A function body may run never, once or later. Its writes are local to
    // the analysis: a `function reset() { here = process.cwd() }` nobody calls
    // used to erase the anchor for the whole module, silently.
    if (scope.barrier) {
      scope.vars.set(name, value);
      return;
    }
  }
  env.vars.set(name, value);
}

/**
 * A name that held a location and was assigned something this cannot evaluate.
 *
 * Silence would be a lie here: the code still builds a path from where it
 * lives, and the analysis simply cannot say which. Reporting it is what makes
 * a branch or a reassignment fail closed.
 */
const UNRESOLVED = Symbol('unresolved location');

/**
 * Evaluate an expression to the location it names, relative to the file.
 *
 * The unit is a resolved relative path rather than a string literal, because
 * literals cannot be checked one at a time: `join(import.meta.dirname,
 * 'assets', 'helper')` names one asset in two pieces, and
 * `new URL('../package.json', new URL('./declared.mjs', import.meta.url))`
 * names two, one of which is fine and one of which is the defect this guard
 * exists for. Both were wrong while the analysis collected literals.
 * @param node - the expression.
 * @param env - the environment it is evaluated in.
 * @returns `{ kind: 'file' | 'dir', path }` where `path` is relative to the
 *   file's own directory, or undefined when the location is not static.
 */
function evaluate(node, env, bindings) {
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, env, bindings);
  // `import.meta.url` names this file; `import.meta.dirname` names its
  // directory. Both are the same place, one level apart.
  if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
    if (node.name.text === 'url') return { kind: 'file', path: '' };
    if (node.name.text === 'dirname') return { kind: 'dir', path: '' };
    return undefined;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'module' && node.name.text === 'filename') {
      return { kind: 'file', path: '' };
    }
    return undefined;
  }
  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname') return { kind: 'dir', path: '' };
    if (node.text === '__filename') return { kind: 'file', path: '' };
    return lookup(env, node.text);
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL' &&
    !isShadowed(env, 'URL')
  ) {
    const [specifier, base] = node.arguments ?? [];
    if (specifier === undefined || base === undefined) return undefined;
    const from = evaluate(base, env, bindings);
    if (from === UNRESOLVED) return UNRESOLVED;
    if (from === undefined) return undefined;
    const literal = stringOf(specifier);
    if (literal === undefined) return UNRESOLVED;
    // An absolute specifier ignores its base and names nothing in this package.
    if (/^[a-z][a-z0-9+.-]*:/i.test(literal)) return undefined;
    // A URL resolves against the directory *containing* a file base, and
    // against a directory base itself — `new URL('./assets/', …)` is one level
    // different from `new URL('./assets', …)`, and the trailing slash is the
    // only thing that says so.
    const from2 = from.kind === 'file' ? parentOf(from.path) : from.path;
    return {
      kind: literal.endsWith('/') ? 'dir' : 'file',
      path: joinRelative([from2, literal]),
    };
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = canonicalCallee(callee, bindings, env);
    const args = node.arguments ?? [];

    // `createRequire(<anchored>)` is that anchor, so a name bound to it stays
    // one: `const req = createRequire(import.meta.url); req('./native.node')`.
    if (name === 'createRequire') {
      return args[0] === undefined ? undefined : evaluate(args[0], env, bindings);
    }
    if (name === 'dirname') {
      const from = args[0] === undefined ? undefined : evaluate(args[0], env, bindings);
      if (from === UNRESOLVED) return UNRESOLVED;
      return from === undefined ? undefined : { kind: 'dir', path: parentOf(from.path) };
    }
    if (name === 'fileURLToPath' || name === 'pathToFileURL') {
      return args[0] === undefined ? undefined : evaluate(args[0], env, bindings);
    }
    if (name === 'join' || name === 'resolve' || name === 'normalize') {
      const from = args[0] === undefined ? undefined : evaluate(args[0], env, bindings);
      if (from === UNRESOLVED) return UNRESOLVED;
      if (from === undefined) return undefined;
      // `join` and friends work on the operand's string, not on the directory
      // its kind implies: `join(fileURLToPath(u), '../package.json')` where `u`
      // is `declared.mjs` names `package.json` beside it, one level from where
      // treating the operand as a directory would put it.
      const segments = [from.path];
      for (const argument of args.slice(1)) {
        const literal = stringOf(argument);
        if (literal === undefined) return UNRESOLVED; // a segment nobody can read
        // `resolve` starts over at an absolute segment; an absolute path is
        // not this package's business either way.
        if (literal.startsWith('/')) return undefined;
        segments.push(literal);
      }
      return { kind: 'file', path: joinRelative(segments) };
    }
    // `createRequire(<anchored>)('./x')`, and the same through a name it was
    // bound to. A require resolves like an import from the file that made it.
    const requireBase = requireAnchor(callee, env, bindings);

    if (requireBase !== undefined) {
      const literal = stringOf(args[0]);
      if (literal === undefined) return undefined;
      if (!literal.startsWith('./') && !literal.startsWith('../')) return undefined; // a package
      return { kind: 'file', path: joinRelative([parentOf(requireBase.path), literal]) };
    }
  }
  // A location reached an expression this does not model — a conditional, a
  // `.pathname`, a slice. Saying nothing would be saying it is not a path.
  let carriesLocation = false;
  ts.forEachChild(node, (child) => {
    if (carriesLocation) return;
    if (!ts.isExpression(child) && !ts.isIdentifier(child)) return;
    const value = evaluate(child, env, bindings);
    if (value !== undefined) carriesLocation = true;
  });
  return carriesLocation ? UNRESOLVED : undefined;
}

/**
 * Whether a callee is a `require` anchored to this file.
 * @param callee - the called expression.
 * @param env - the environment.
 * @returns the location the require resolves from, or undefined.
 */
function requireAnchor(callee, env, bindings) {
  if (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'createRequire'
  ) {
    return (callee.arguments ?? [])[0] === undefined
      ? undefined
      : evaluate(callee.arguments[0], env, bindings);
  }
  // CommonJS `require('./x')` resolves against its own file, with no anchor to
  // see. `.cjs` is scanned, so it is read as anchored to the file itself.
  if (canonicalCallee(callee, bindings, env) === 'require') return { kind: 'file', path: '' };
  if (ts.isIdentifier(callee)) return lookup(env, callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    // `req.resolve('./x')`, where `req` came from `createRequire`.
    if (callee.name.text === 'resolve') return lookup(env, callee.expression.text);
  }
  return undefined;
}

/**
 * A string literal's contents, when the node is one.
 * @param node - the node to read.
 * @returns the text, or undefined for anything computed.
 */
function stringOf(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Every location a file resolves against its own, as relative paths.
 *
 * Parsed and evaluated rather than scanned. Three earlier shapes of this failed
 * open: a regex window went quiet on a formatter's line break, a boolean
 * "anchored" flag let an inner declared asset hide an outer undeclared one, and
 * collecting literals reported `assets` and `helper` as two paths where the
 * code names one.
 *
 * What it still cannot see is a location that is not static — a segment from
 * configuration, a name held in a parameter. That limit is real, and the
 * bundling case in the test is what covers the property rather than its
 * spelling.
 * @param source - the file's text.
 * @param name - a file name, for the parser's diagnostics.
 * @returns relative paths, deduplicated, `''` excluded because it is the file's
 *   own directory rather than something it reaches.
 */
export function analyzeRuntimePaths(source, name = 'input.js') {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = collectBindings(file);
  const resolved = new Set();
  const unresolved = new Set();

  /**
   * Whether a call is one of the operations that turns a location into a path.
   * @param node - the call or `new` expression.
   * @param env - the environment, for shadowing.
   * @returns true when the guard has an opinion about this call.
   */
  const isPathOperation = (node, env) => {
    if (ts.isNewExpression(node)) {
      return ts.isIdentifier(node.expression) && node.expression.text === 'URL' && !isShadowed(env, 'URL');
    }
    if (canonicalCallee(node.expression, bindings, env) !== undefined) return true;
    // `createRequire(anchor)('./x')` and `req('./x')`.
    return requireAnchor(node.expression, env, bindings) !== undefined;
  };

  const walk = (node, env) => {
    let scope = env;
    if (
      ts.isFunctionLike(node) ||
      ts.isBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isCaseBlock(node)
    ) {
      scope = newEnv(env, ts.isFunctionLike(node));
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          if (ts.isIdentifier(parameter.name)) declare(scope, parameter.name.text, undefined);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(scope, node.name.text, node.initializer && evaluate(node.initializer, scope, bindings));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const was = lookup(scope, node.left.text);
      const now = evaluate(node.right, scope, bindings);
      // A name that held a location and now holds something unreadable is not
      // free of it: the code may still build a path from here, and which one
      // depends on a branch this cannot follow.
      assign(scope, node.left.text, now === undefined && was !== undefined ? UNRESOLVED : now);
    }

    // Two kinds of "below", because they suppress different things: a path
    // that resolved inside says nothing about the one being built around it,
    // and only an unreadable inner path makes the outer report a duplicate.
    let unresolvedBelow = false;
    ts.forEachChild(node, (child) => {
      if (walk(child, scope) === 'unresolved') unresolvedBelow = true;
    });

    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isPathOperation(node, scope)) {
      const at = evaluate(node, scope, bindings);
      // `''` is the file's own directory: reaching it is not reaching out.
      if (at !== undefined && at !== UNRESOLVED && at.path !== '') {
        resolved.add(at.path);
        return unresolvedBelow ? 'unresolved' : 'resolved';
      }
      // An outer path operation that cannot be read still has to be reported —
      // an inner one that resolved says nothing about it. What is suppressed is
      // only a second report of the *same* unreadable path, so
      // `readFileSync(join(dir, name), 'utf8')` names `join(…)` once.
      if (at === UNRESOLVED && !unresolvedBelow) {
        unresolved.add(node.getText().replace(/\s+/g, ' ').slice(0, 120));
        return 'unresolved';
      }
    }
    return unresolvedBelow ? 'unresolved' : undefined;
  };
  const top = newEnv(undefined);
  // Two passes: module-level declarations first, because a function written
  // above the `const` it reads is ordinary code and analysing it in source
  // order lost the anchor.
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declare(top, declaration.name.text, evaluate(declaration.initializer, top, bindings));
      }
    }
  }
  walk(file, top);
  // Sorted: the order a walk happens to reach things is not information, and
  // a stable report is easier to read and to assert on.
  return { resolved: [...resolved].sort(), unresolved: [...unresolved].sort() };
}

/**
 * The locations a file resolves against its own, for callers that only want
 * the ones this could pin down.
 * @param source - the file's text.
 * @param name - a file name, for the parser's diagnostics.
 * @returns relative paths.
 */
export function runtimePathLiterals(source, name = 'input.js') {
  return analyzeRuntimePaths(source, name).resolved;
}

/**
 * The declared runtime assets, by package name.
 * @returns the parsed declaration, without its comment key.
 */
export function declaredRuntimeAssets() {
  const declared = JSON.parse(readFileSync(join(root, 'scripts/runtime-assets.json'), 'utf8'));
  delete declared.$comment;
  return declared;
}

/**
 * Whether a package's `files` would pack a path.
 * @param pkg - the package descriptor.
 * @param path - an absolute path inside the package.
 * @returns true when some `files` entry covers it.
 */
function isPacked(pkg, path) {
  return pkg.files.some((entry) => contains(join(pkg.dir, entry), path));
}

/**
 * Check one publishable package's shipped code.
 * @param pkg - the package: `{ name, dir, files }`, as `publishablePackages`
 *   describes it. Exported so a test can hand it a package built to have the
 *   defect, which is the only way to watch this refuse anything — the ones it
 *   was written for are all fixed.
 * @param declared - runtime assets allowed for this package, relative to it.
 * @returns human-readable failures; empty when the package is clean.
 */
export function checkPackage(pkg, declared = []) {
  const failures = [];
  const allowed = new Set(declared.map((entry) => resolve(pkg.dir, entry)));

  // A declaration that has rotted is worse than none: it reads as considered.
  for (const entry of declared) {
    const target = resolve(pkg.dir, entry);
    if (!existsSync(target)) {
      failures.push(`${pkg.name}: declared runtime asset '${entry}' does not exist`);
    } else if (!isPacked(pkg, target)) {
      failures.push(
        `${pkg.name}: declared runtime asset '${entry}' is not in this package's "files", ` +
          `so it is absent from the published tarball`,
      );
    }
  }

  // Every `files` entry has to be there, and the check has to have had
  // something to read. Otherwise an unbuilt package passes for want of input,
  // which is how a check like this dies quietly.
  const scanned = [];
  for (const entry of pkg.files) {
    if (/[*?!\[\]{}()]/.test(entry)) {
      failures.push(
        `${pkg.name}: "files" entry '${entry}' is a pattern, and this check reads literal ` +
          `paths only — spell the file out, or teach the guard packlist semantics`,
      );
      continue;
    }
    const path = join(pkg.dir, entry);
    if (!existsSync(path)) {
      failures.push(
        `${pkg.name}: "files" lists '${entry}', which is not there — build the workspace first (pnpm -r build)`,
      );
      continue;
    }
    const walk = statSync(path).isDirectory() ? filesUnder(path) : [path];
    scanned.push(...walk.filter((file) => SCANNED.some((ext) => file.endsWith(ext))));
  }
  if (failures.length === 0 && scanned.length === 0) {
    failures.push(`${pkg.name}: no built JavaScript to check — build the workspace first`);
  }

  const reached = new Set();
  for (const file of scanned) {
    const analysis = analyzeRuntimePaths(readFileSync(file, 'utf8'), file);
    for (const expression of analysis.unresolved) {
      failures.push(
        `${pkg.name} ${relative(pkg.dir, file)} → ${expression}: builds a path from this file's ` +
          `own location and cannot be resolved statically, so nothing can say whether the target ` +
          `ships. Write it so it can be read, or compile the value in`,
      );
    }
    for (const literal of analysis.resolved) {
      const target = resolve(dirname(file), literal);
      if (allowed.has(target)) {
        reached.add(target);
        continue;
      }
      failures.push(
        `${pkg.name} ${relative(pkg.dir, file)} → ${literal}: resolved at run time and not a ` +
          `declared runtime asset, so it points at whatever surrounds a consumer's copy. ` +
          `Compile the value in, or add it to scripts/runtime-assets.json`,
      );
    }
  }

  // A declaration nothing reaches is a standing exemption for whatever is
  // written there next. The list only stays an allowlist while every line of it
  // is still earning its place.
  for (const entry of declared) {
    const target = resolve(pkg.dir, entry);
    if (existsSync(target) && !reached.has(target)) {
      failures.push(
        `${pkg.name}: declared runtime asset '${entry}' is not reached by any published code — ` +
          `remove it rather than leave an exemption nothing needs`,
      );
    }
  }
  return failures;
}

/**
 * Check every publishable package.
 * @returns human-readable failures across the workspace.
 */
export function verifyRuntimePaths() {
  const declared = declaredRuntimeAssets();
  const packages = publishablePackages();
  const failures = packages.flatMap((pkg) => checkPackage(pkg, declared[pkg.name] ?? []));
  // A declaration for a package that no longer publishes is the same rot as a
  // declaration for a file that no longer exists.
  const names = new Set(packages.map((pkg) => pkg.name));
  for (const name of Object.keys(declared)) {
    if (!names.has(name))
      failures.push(`scripts/runtime-assets.json names '${name}', which does not publish`);
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = verifyRuntimePaths();
  if (failures.length > 0) {
    console.error('verify-runtime-paths: published code reaches paths that will not be there:');
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }
  const declared = Object.values(declaredRuntimeAssets()).flat().length;
  console.log(
    `verify-runtime-paths: ${publishablePackages().length} published package(s), ` +
      `${declared} declared runtime asset(s), no stray path`,
  );
}
