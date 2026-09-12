import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { authConfigured } from "./auth.js";
import { closeClickhouse } from "./clients/clickhouse.js";
import { closePostgres } from "./clients/postgres.js";
import { destroyS3Clients } from "./clients/s3.js";
import { config } from "./config.js";
import { errorMessage, log } from "./logger.js";
import { registerApi } from "./routes/api.js";
import { applySchedule } from "./scheduler.js";
import { getPolicy, loadState } from "./state.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  await loadState();

  if (!authConfigured()) {
    log.error(
      "RETENTION_ADMIN_PASSWORD is not set. Set it, or set RETENTION_AUTH_DISABLED=true " +
        "if the dashboard is only reachable on a trusted network.",
    );
    process.exit(1);
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    // Behind langfuse-web's reverse proxy or a compose-internal network.
    trustProxy: true,
  });

  await registerApi(app);

  // The dashboard is plain HTML/CSS/JS served from disk; no build step, no bundler.
  await app.register(fastifyStatic, { root: join(here, "..", "public"), index: ["index.html"] });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });

  applySchedule(getPolicy());

  await app.listen({ port: config.port, host: config.host });
  log.info("langfuse-open-retention listening", {
    url: `http://${config.host}:${config.port}`,
    dryRun: getPolicy().dryRun,
    retentionDays: getPolicy().defaultRetentionDays,
  });

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    await app.close();
    await Promise.allSettled([closeClickhouse(), closePostgres()]);
    destroyS3Clients();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  log.error("failed to start", errorMessage(e));
  process.exit(1);
});
