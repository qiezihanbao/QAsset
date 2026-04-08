import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 4174,
    strictPort: true,
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return

          if (id.includes("pdfjs-dist")) return "vendor-pdf"
          if (
            id.includes("react-markdown") ||
            id.includes("remark-gfm") ||
            id.includes("rehype-highlight")
          ) return "vendor-markdown"
          if (id.includes("highlight.js")) return "vendor-highlight"
          if (id.includes("framer-motion")) return "vendor-motion"
          if (id.includes("@tauri-apps")) return "vendor-tauri"
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    tsconfigPaths()
  ],
})
