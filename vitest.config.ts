import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/index.ts', 'src/serve.ts', 'src/cli.ts', 'src/version.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
    },
  },
});
