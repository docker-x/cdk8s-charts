import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', '.github/scripts/**/*.test.ts'],
    globals: false,
  },
});
