import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const pythonRuntimeRoot = path.resolve(
  fileURLToPath(new URL("../frontend/public/python-runtime", import.meta.url)),
);
const pythonRuntimeMime: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
};

export default defineConfig({
  base: "/teacher/",
  publicDir: fileURLToPath(new URL("../frontend/public", import.meta.url)),
  build: { copyPublicDir: false },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "python-runtime-dev",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const rawUrl = req.url?.split("?")[0] ?? "";
          if (!rawUrl.startsWith("/python-runtime/")) {
            next();
            return;
          }
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("X-Content-Type-Options", "nosniff");
          let rel: string;
          try {
            rel = decodeURIComponent(rawUrl.slice("/python-runtime/".length));
          } catch {
            res.statusCode = 400;
            res.end("Bad Request");
            return;
          }
          const filePath = path.resolve(pythonRuntimeRoot, rel);
          if (!filePath.startsWith(pythonRuntimeRoot + path.sep) || !existsSync(filePath)) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          const stat = statSync(filePath);
          if (!stat.isFile()) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          if (pythonRuntimeMime[ext]) res.setHeader("Content-Type", pythonRuntimeMime[ext]);
          res.setHeader("Content-Length", String(stat.size));
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(filePath).pipe(res);
        });
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../shared", import.meta.url))] },
    proxy: { "/api": process.env.API_PROXY ?? "http://127.0.0.1:18081" },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
  },
});
