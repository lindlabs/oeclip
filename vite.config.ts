import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { transform } from "esbuild";

function motionCompilerPlugin(): Plugin {
  return {
    name: "motion-compiler-dev-endpoint",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (
          req.method === "POST" &&
          (url === "/api/motion/compile" || (url?.startsWith("/api/projects/") && url?.endsWith("/motion/compile")))
        ) {
          let raw = "";
          req.on("data", (chunk: Buffer | string) => {
            raw += chunk;
          });
          req.on("end", async () => {
            try {
              const body = JSON.parse(raw || "{}");
              const code = String(body.code || "");
              const componentName = String(body.componentName || "MotionComp");
              const result = await transform(code, {
                loader: "tsx",
                jsx: "transform",
                jsxFactory: "React.createElement",
                jsxFragment: "React.Fragment",
                format: "cjs",
                target: "es2020",
              });
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, cjs: result.code, exportedName: componentName }));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: false, error: msg }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), motionCompilerPlugin()],
  resolve: {
    alias: { "@shared": path.resolve(process.cwd(), "src/shared") },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4331",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/remotion") || id.includes("@remotion")) {
            return "remotion";
          }
        },
      },
    },
  },
});
