import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { registerApi } from "./routes/api.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The HTTP server, separate from process start-up so tests can drive it with
 * `app.inject()` instead of binding a port.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Behind langfuse-web's reverse proxy or a compose-internal network.
    trustProxy: true,
  });

  /**
   * Treat an empty JSON body as `{}`.
   *
   * Fastify otherwise rejects `Content-Type: application/json` with no payload
   * (FST_ERR_CTP_EMPTY_JSON_BODY), which is a needless 400 for endpoints that
   * take no input at all — logout being the obvious one. Malformed JSON is still
   * a 400; only *absent* JSON is forgiven.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      const error = new Error("Body is not valid JSON.") as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  await registerApi(app);

  // The dashboard is plain HTML/CSS/JS served from disk; no build step, no bundler.
  await app.register(fastifyStatic, { root: join(here, "..", "public"), index: ["index.html"] });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });

  return app;
}
