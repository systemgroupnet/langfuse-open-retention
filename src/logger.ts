type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};

/** Errors are not JSON-serializable; flatten them for logging and for run reports. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
