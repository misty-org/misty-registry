import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
