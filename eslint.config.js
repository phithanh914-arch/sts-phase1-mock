import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
);
