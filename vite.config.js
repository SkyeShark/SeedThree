import { defineConfig } from 'vite';

// Dev server pinned to 5390 to avoid the user's other local services
// (5173 Vite-default is taken, 8188 ComfyUI, 8000/8001 aletheia, etc.).
// strictPort: fail loudly instead of silently hopping to another port.
export default defineConfig({
  server: {
    port: 5390,
    strictPort: true,
  },
  preview: {
    port: 5390,
    strictPort: true,
  },
});
