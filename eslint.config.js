import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: ['dist'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-console': 'off',
    },
  },
];
