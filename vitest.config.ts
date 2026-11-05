import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': new URL('./test/helpers/worker-entrypoint.ts', import.meta.url).pathname } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
