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
      includeAssets: ['favicon.svg'],
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
        icons: [{ src: '/favicon.svg', sizes: '192x192', type: 'image/svg+xml' }]
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
