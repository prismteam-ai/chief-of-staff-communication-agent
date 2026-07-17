import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic tests only (e.g. CommunicationCard.test.ts) — no rendering, so the plain node
    // environment is sufficient; no jsdom/React Testing Library dependency added for this.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
