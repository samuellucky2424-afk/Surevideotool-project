import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiProxyTarget = env.API_PROXY_TARGET || env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    root: __dirname,
    build: {
      outDir: path.resolve(__dirname, 'dist'),
    },
    base: './',
    plugins: [inspectAttr(), react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
