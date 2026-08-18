import { join } from "node:path";
import {
  DOCS_SECURITY_HEADERS,
  HTML_CACHE_CONTROL,
  OPENAPI_CACHE_CONTROL,
  SCALAR_BUNDLE_CACHE_CONTROL,
} from "../src/static-headers";

const root = join(import.meta.dir, "../dist");

const contentType = (path: string): string => {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
};

const cacheControl = (path: string): string => {
  if (path.startsWith("/vendor/scalar/")) return SCALAR_BUNDLE_CACHE_CONTROL;
  if (path === "/openapi.json") return OPENAPI_CACHE_CONTROL;
  return HTML_CACHE_CONTROL;
};

export const serveDocsDist = (port: number) =>
  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname =
        url.pathname === "/" ? "/index.html" : url.pathname.replace(/\/$/u, "");
      const file = Bun.file(join(root, pathname));
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(file, {
        headers: {
          ...DOCS_SECURITY_HEADERS,
          "cache-control": cacheControl(url.pathname),
          "content-type": contentType(pathname),
        },
      });
    },
  });

if (import.meta.main) {
  const port = Number(process.env.DOCS_PORT ?? "4321");
  serveDocsDist(port);
  console.info(`Serving docs dist on http://127.0.0.1:${port}`);
}
