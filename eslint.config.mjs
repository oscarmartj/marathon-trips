import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Shared flat config. Module-boundary rules arrive with the first business module (1.1).
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/generated/**', '**/.turbo/**', 'apps/web/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Money is never a float, and tests are never skipped (CI also fails on skipped tests).
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name=/^(it|test|describe)$/][callee.property.name=/^(skip|todo)$/]", message: 'Skipped tests are not allowed.' },
        { selector: "CallExpression[callee.object.name=/^(it|test|describe)$/][callee.property.name='only']", message: 'Focused tests are not allowed.' },
      ],
    },
  },
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { sourceType: 'module' } },
);
