import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [vue(), tailwindcss()],
  ...(command === "serve" ? { resolve: { conditions: ["source"] } } : {}),
  server: { host: true },
}));
