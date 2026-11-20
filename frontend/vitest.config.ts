import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [vue()],
  server: { fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), fileURLToPath(new URL('../shared/', import.meta.url))] } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "jsdom", include: ["tests/**/*.spec.ts"] },
});
