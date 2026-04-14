import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      include: ['src/app/core/botExecution.ts', 'src/app/core/scope.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', 'node_modules'],
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 100,
        lines: 98,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
