import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const versions = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8')) as {
  easynote: string;
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'EasyNote',
        short_name: 'EasyNote',
        description: '自托管 Markdown 图片笔记',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0071e3',
        categories: ['productivity'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Explicit injection disables the plugin's autoUpdate defaults; preserve immediate takeover.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: [
          '**/*.{html,css,svg}',
          'registerSW.js',
          'manifest.webmanifest',
          // Include Pele's lazy diagram chunk for first-use offline previews.
          'assets/*.js',
        ],
        globIgnores: ['assets/pdfmake-*.js', 'assets/pdfjs-*.js'],
        runtimeCaching: [{
          urlPattern: /\/(?:assets\/(?:pdfmake|pdfjs|pdf\.worker)[^/]*\.(?:js|mjs)|fonts\/NotoSansSC-(?:Regular|Bold)\.otf)$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'easynote-pdf-v1',
            cacheableResponse: { statuses: [0, 200] },
          },
        }],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/share\//,
          /^\/oauth\//,
          /^\/\.well-known\//,
          /^\/mcp/,
        ],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  define: {
    __EASYNOTE_VERSION__: JSON.stringify(versions.easynote),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const rewriteOrigin = (outgoing: { setHeader(name: string, value: string): void }, incoming: { headers: { origin?: string; host?: string } }) => {
            if (incoming.headers.origin === `http://${incoming.headers.host}`) {
              outgoing.setHeader('Origin', 'http://127.0.0.1:8791');
            }
          };
          proxy.on('proxyReq', rewriteOrigin);
          proxy.on('proxyReqWs', rewriteOrigin);
        },
      },
    },
  },
  build: {
    outDir: 'dist/client',
    // Pele is a single lazy-loaded diagram chunk (~685 kB / ~255 kB gzip);
    // the largest other intentional async vendor chunk is pdfmake (~1.03 MB).
    // Keep Vite's warning useful for application chunks while allowing these.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/@codemirror/') || id.includes('/@lezer/')) return 'editor';
          if (id.includes('/markdown-it/') || id.includes('/dompurify/')) return 'markdown';
          if (id.includes('/pdfjs-dist/')) return 'pdfjs';
          if (id.includes('/pdfmake/') || id.includes('/html-to-pdfmake/')) return 'pdfmake';
        },
      },
    },
  },
});
