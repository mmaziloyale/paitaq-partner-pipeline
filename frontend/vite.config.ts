import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev mode: the FastAPI backend runs on port 8000 and /api calls are passed through.
// Normal use: `python run.py` serves the built site (frontend/dist) from the backend itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8000' } },
})
