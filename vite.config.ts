import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: './',
  plugins: [
    // HTTPS in dev so phone browsers treat the site as a secure context and
    // allow microphone access + service workers. Accept the self-signed cert
    // warning on the phone once.
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Door Knocking Notes',
        short_name: 'DoorNotes',
        description:
          'Privacy-first, fully on-device door knocking notes. Record and transcribe locally — nothing leaves your device.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // The Whisper model is large; precache only the app shell. Model
        // files are cached at runtime by the transformers.js cache.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
