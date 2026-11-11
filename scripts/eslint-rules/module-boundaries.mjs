// ESLint rule: module boundaries (plan 0.1, section 2 and 3.1).
//  - Code in apps/api/src/modules/<a>/ may import another module <b> only through its public index
//    (`../<b>` or `../<b>/index`), never a file inside it.
//  - Code in apps/api/src/platform/ never imports from apps/api/src/modules/.
// Everything else (platform from a module, the module's own files, packages) is free.
import path from 'node:path';

const norm = (p) => p.split(path.sep).join('/');

/** Where does a file live? Returns { area: 'module', name } | { area: 'platform' } | null. */
export function locate(file) {
  const f = norm(file);
  const m = /\/apps\/api\/src\/modules\/([^/]+)\//.exec(f);
  if (m) return { area: 'module', name: m[1] };
  if (/\/apps\/api\/src\/platform\//.test(f)) return { area: 'platform' };
  return null;
}

/** Decide whether `spec` imported from `file` breaks a boundary. Returns a message or null. */
export function violation(file, spec) {
  const here = locate(file);
  if (!here || !spec.startsWith('.')) return null;
  const target = norm(path.resolve(path.dirname(file), spec));
  const modules = /\/apps\/api\/src\/modules\/([^/]+)(?:\/(.*))?$/.exec(target);
  if (here.area === 'platform') {
    return modules ? `platform code must not import from modules (${modules[1]})` : null;
  }
  if (!modules || modules[1] === here.name) return null;
  const rest = modules[2];
  if (rest === undefined || rest === 'index') return null;
  return `import the public index of module "${modules[1]}", not "${modules[1]}/${rest}"`;
}

export default {
  rules: {
    'module-boundaries': {
      meta: { type: 'problem', schema: [], messages: { boundary: '{{ message }}' } },
      create(context) {
        const check = (node, spec) => {
          const message = typeof spec === 'string' ? violation(context.filename, spec) : null;
          if (message) context.report({ node, messageId: 'boundary', data: { message } });
        };
        return {
          ImportDeclaration: (n) => check(n, n.source.value),
          ExportAllDeclaration: (n) => check(n, n.source?.value),
          ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
          ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
        };
      },
    },
  },
};
