import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The engine is Electron-free by design, so the whole suite runs headless in WSL and in CI.
    // Nothing here may require a Chromecast, a window, or Windows.
    restoreMocks: true,
  },
});
