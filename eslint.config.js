import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // `.claude/**` holds agent worktrees — full checkouts of this repo, each with its own
    // tsconfig. Linting them makes typescript-eslint see several candidate roots and refuse
    // to parse anything ("multiple candidate TSConfigRootDirs"), so `npm run lint` goes red
    // locally for a reason that has nothing to do with the code. .gitignore already excludes
    // them; CI never sees them because it checks out clean, which is why this went unnoticed.
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'coverage/**', '.claude/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // The engine boundary, enforced by lint as well as by test/architecture/engine-boundary.test.ts.
  // Two belts: lint catches it while you type, the test catches it in CI.
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'src/engine/ must stay Electron-free so it runs headless under vitest. Put Electron code in src/main/.',
            },
          ],
          patterns: ['electron/*', '**/main/**'],
        },
      ],
    },
  },

  // Node scripts and config files: plain JS, no type-aware linting.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },

  // `.cjs` means CommonJS, and CommonJS means `require`. The repo is ESM
  // ("type": "module"), so the few files that must be CJS carry the extension that says
  // so — electron-builder loads its hooks with `require()` first, and an .mjs hook would
  // resolve differently depending on the Node version. Banning `require` here would only
  // force the ambiguity back.
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettier,
);
