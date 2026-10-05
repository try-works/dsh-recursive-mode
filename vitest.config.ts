import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Establishes the fixture preconditions git cannot carry (run-directory
    // mtimes). See tests/global-setup.ts for why this is required.
    globalSetup: ['tests/global-setup.ts'],
  },
  resolve: {
    // Let @deepseek-ai/* resolve from the DSH workspace when linked.
    conditions: ['node', 'import'],
  },
})