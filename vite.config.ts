import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/renderer', import.meta.url));

/**
 * In dev, @vitejs/plugin-react injects its Fast Refresh preamble as an *inline*
 * <script type="module">. index.html ships a strict `script-src 'self'`, which
 * Electron enforces — the preamble gets blocked, `$RefreshReg$` is never defined,
 * and every transformed module throws, leaving an empty window.
 *
 * The packaged app has no preamble and must stay strict, so relax script-src for
 * the dev server only. `apply: 'serve'` is what keeps this out of the build.
 */
const devCsp = {
  name: 'castgood:dev-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
  },
};

export default defineConfig({
  root,
  // Relative base: the packaged app loads the renderer from file://, not from a server.
  base: './',
  plugins: [react(), tailwindcss(), devCsp],
  server: {
    // Electron connects to this from the same machine; no need to expose it on the LAN.
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
});
