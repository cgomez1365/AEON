import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  optimizeDeps: {
    exclude: [],
    entries: ['index.html'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-icons': ['lucide-react'],
          'vendor-charts': ['recharts'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-3d': ['three', '@react-three/fiber', '@react-three/drei'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Precache the icon files the app actually loads (index.html, the layouts
      // and public/manifest.json all point at brand/aeon-mark/). The previous
      // list named the brand-root duplicates, which nothing renders, so an
      // installed PWA could evict the real sidebar mark and lose it offline.
      includeAssets: [
        'favicon.ico',
        'brand/aeon-mark/aeon-mark.svg', 'brand/aeon-mark/aeon-mark-compact.svg',
        'brand/aeon-mark/aeon-icon-16.png', 'brand/aeon-mark/aeon-icon-32.png', 'brand/aeon-mark/aeon-icon-48.png',
        'brand/aeon-mark/aeon-icon-64.png', 'brand/aeon-mark/aeon-icon-128.png',
        'brand/aeon-mark/aeon-icon-192.png', 'brand/aeon-mark/aeon-icon-256.png', 'brand/aeon-mark/aeon-icon-512.png',
        'brand/aeon-mark/aeon-icon-maskable-180.png',
        'brand/aeon-mark/aeon-icon-maskable-192.png', 'brand/aeon-mark/aeon-icon-maskable-512.png',
      ],
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000,
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        // CRITICAL: iframe loads are `mode: "navigate"` requests, and Workbox's
        // NavigationRoute matches them. Without this denylist the SW serves
        // index.html INTO the Matrix's visualizer iframe — the whole SPA boots
        // nested inside the graph panel and redirects to the Dashboard
        // (the "duplicate AEON viewport" bug). Server routes must never be
        // answered by the SPA shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/core\//, /^\/block\//, /^\/blocks\//, /^\/events/, /^\/ws/],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 300 } }
          },
          {
            urlPattern: /\.(js|css|png|jpg|jpeg|svg|gif|woff2?)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'assets-cache', expiration: { maxEntries: 100, maxAgeSeconds: 86400 } }
          }
        ]
      },
      manifest: {
        name: 'AEON CORTEX',
        short_name: 'AEON',
        theme_color: '#020508',
        background_color: '#020508',
        display: 'standalone',
        // Kept identical to public/manifest.json (index.html links that one
        // first; this one is emitted as manifest.webmanifest). Two manifests is
        // one too many, but the two icon lists at least cannot disagree now.
        // The maskable slot gets the MASKABLE cut: square ground, drawing at
        // 80% so nothing sits outside the 40% safe circle a launcher keeps.
        // The rounded "any" icon in that slot had its node circles cut in half
        // under a circular mask and let wallpaper through its corners.
        // The 16/32/48 "any" entries are the compact cut. An installed PWA
        // builds its taskbar and title-bar icons from the manifest, never from
        // favicon.ico, and downscales the largest listed icon for any size it
        // lacks - without these, Windows showed the 192px full mark shrunk to
        // 16-48px: the original smudge on one prominent surface.
        // Every size Chrome's installed-app pipeline wants (64/96/128/256 for
        // chrome://apps, the macOS Dock, Windows Start and Alt-Tab) has an
        // own-size render listed, so the browser never resamples one itself.
        icons: [
          { src: '/brand/aeon-mark/aeon-icon-16.png', sizes: '16x16', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-32.png', sizes: '32x32', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-48.png', sizes: '48x48', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/brand/aeon-mark/aeon-icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/brand/aeon-mark/aeon-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]
      }
    })
  ],
  server: {
    port: 3000,
    host: true,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/block': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/core': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/events': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    }
  }
})
