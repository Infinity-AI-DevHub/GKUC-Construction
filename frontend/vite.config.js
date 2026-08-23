import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3400,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4400',
        changeOrigin: false,
        /*
         * Survive the API being restarted.
         *
         * Vite's proxy emits an unhandled 'error' when the target refuses a connection,
         * which takes the whole dev server down with it — so restarting the backend also
         * killed the frontend, and the browser was left with nothing to reconnect to.
         * Answering 502 keeps the dev server up and lets the client retry, which is what
         * it is built to do. Only development is affected: in production one Express
         * process serves both the API and the built files, with no proxy in between.
         */
        configure: proxy => {
          proxy.on('error', (error, _req, res) => {
            if (res && !res.headersSent && res.writeHead) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'The API is not running' }));
            } else if (res && res.end) {
              res.end();
            }
            console.warn(`[vite] API unreachable: ${error.code || error.message}`);
          });
        }
      }
    }
  }
});
