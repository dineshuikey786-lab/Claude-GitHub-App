import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev:local` points these at the backend running on this machine.
const backend = process.env.MATAI_BACKEND || 'https://higgsfield-matu.netlify.app';

export default defineConfig({
    base: './',
    plugins: [
        tailwindcss(),
    ],
    server: {
        proxy: {
            '/api': {
                target: 'https://api.kie.ai',
                changeOrigin: true,
                secure: false
            },
            '/.netlify/functions': {
                target: backend,
                changeOrigin: true,
                secure: true
            },
            '/download-media': {
                target: backend,
                changeOrigin: true,
                secure: true
            }
        }
    }
});
