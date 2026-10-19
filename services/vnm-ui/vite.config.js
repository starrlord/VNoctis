import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

function offlineShell() {
  return { name: 'vnm-offline-shell', writeBundle(options) {
    const directory = options.dir || 'dist';
    const paths = ['index.html', 'save-sync.js', 'save-offline.js', 'game-cache-worker.js',
      ...readdirSync(path.join(directory, 'assets')).map(name => 'assets/' + name)].sort();
    const files = paths.map(name => { const bytes = readFileSync(path.join(directory, name));
      return { path: '/' + name, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }; });
    const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    writeFileSync(path.join(directory, 'offline-shell.json'), JSON.stringify({ version, files }));
    const worker = path.join(directory, 'app-offline-worker.js');
    writeFileSync(worker, readFileSync(worker, 'utf8').replace('__VNM_SHELL_VERSION__', version));
  } };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), offlineShell()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SAVE_SYNC_VERSION__: JSON.stringify(createHash('sha256').update(readFileSync('./public/save-sync.js')).digest('hex')),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://vnm-api:3001',
        changeOrigin: true,
      },
    },
  },
});
