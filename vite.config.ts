import { defineConfig, type ProxyOptions } from 'vite';
import vue from '@vitejs/plugin-vue';

const target = 'http://localhost:8787';
const workerProxy: ProxyOptions = {
  target,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      // Translate legitimate dev-server origins to Wrangler's origin. Foreign
      // or absent Origin headers remain unchanged and fail the Worker check.
      const origin = incoming.headers.origin;
      const host = incoming.headers.host;
      if (origin === `http://${host}` || origin === `https://${host}`) {
        outgoing.setHeader('Origin', target);
      }
    });
  },
};

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '^/api(?:/|$)': workerProxy,
      '^/s(?:/|$)': workerProxy,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'admin/index.html',
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/@vue/') || id.includes('/vue/')) return 'vue';
          if (id.includes('/ant-design-vue/') || id.includes('/@ant-design/')) return 'antd';
          return 'vendor';
        },
      },
    },
  },
});
