import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
  resolve: {
    // Let @deepseek-ai/* resolve from the DSH workspace when linked.
    conditions: ['node', 'import'],
  },
})