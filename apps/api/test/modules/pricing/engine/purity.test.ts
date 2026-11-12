// engine_is_pure and only_rounding_divides_money (plan 2.1, threat 2 and M11): walks the TypeScript syntax tree of
// the pricing module, so comments, strings and import paths cannot fool it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const moduleDir = join(__dirname, '../../../../src/modules/pricing');
const engineDir = join(moduleDir, 'engine');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

const where = (sf: ts.SourceFile, n: ts.Node) => `${relative(moduleDir, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

/** Division and remainder: the only ways to lose a cent. */
function divisions(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const ops = new Set([ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken]);
  walk(sf, (n) => {
    if (ts.isBinaryExpression(n) && ops.has(n.operatorToken.kind)) out.push(`${where(sf, n)} ${n.operatorToken.getText()}`);
  });
  return out;
}

/** Clock reads, floating point helpers and imports from outside the engine. */
function impurities(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      const text = n.getText();
      if (/^(Date|performance)\.now$/.test(text)) out.push(`${where(sf, n)} ${text}`);
      if (ts.isIdentifier(n.expression) && n.expression.text === 'Math') out.push(`${where(sf, n)} ${text}`);
      if (n.name.text === 'toFixed' || n.name.text === 'toPrecision') out.push(`${where(sf, n)} ${text}`);
    }
    if (ts.isNewExpression(n) && n.expression.getText() === 'Date' && (n.arguments?.length ?? 0) === 0) out.push(`${where(sf, n)} new Date()`);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['Number', 'parseFloat', 'parseInt'].includes(n.expression.text)) out.push(`${where(sf, n)} ${n.expression.text}()`);
    if (ts.isImportDeclaration(n)) {
      const from = (n.moduleSpecifier as ts.StringLiteral).text;
      if (!from.startsWith('./') && from !== '@mt/shared') out.push(`${where(sf, n)} imports ${from}`);
    }
    if (ts.isNumericLiteral(n) && n.text.includes('.')) out.push(`${where(sf, n)} decimal literal ${n.text}`);
  });
  return out;
}

describe('engine_is_pure', () => {
  it('no clock, no Math, no float parsing, no imports from outside the engine', () => {
    const found = files(engineDir).flatMap((f) => impurities(parse(f)));
    expect(found).toEqual([]);
  });
  it('the checker catches each kind of impurity', () => {
    const sf = ts.createSourceFile('x.ts', "import { x } from '../../platform/db';\nconst a = Date.now();\nconst b = new Date();\nconst c = Math.round(1);\nconst d = Number('1');\nconst e = (1).toFixed(2);\nconst f = 0.5;", ts.ScriptTarget.Latest, true);
    expect(impurities(sf)).toHaveLength(7);
  });
});

describe('only_rounding_divides_money', () => {
  it('no file of the pricing module divides, except rounding.ts (money) and calendar.ts (days)', () => {
    const allowed = new Set(['engine/rounding.ts', 'engine/calendar.ts']);
    const found = files(moduleDir).filter((f) => !allowed.has(relative(moduleDir, f).split('\\').join('/'))).flatMap((f) => divisions(parse(f)));
    expect(found).toEqual([]);
  });
  it('calendar.ts holds no money: no bigint at all', () => {
    const sf = parse(join(engineDir, 'calendar.ts'));
    const found: string[] = [];
    walk(sf, (n) => {
      if (n.kind === ts.SyntaxKind.BigIntLiteral || n.kind === ts.SyntaxKind.BigIntKeyword || (ts.isIdentifier(n) && n.text === 'BigInt')) found.push(where(sf, n));
    });
    expect(found).toEqual([]);
  });
  it('the checker catches /, %, /= and %=', () => {
    const sf = ts.createSourceFile('x.ts', 'let a = 1n / 2n; let b = 3n % 2n; a /= 2n; b %= 2n; // 1 / 2 in a comment\nconst s = "a/b";', ts.ScriptTarget.Latest, true);
    expect(divisions(sf)).toHaveLength(4);
  });
});
