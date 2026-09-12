import cron, { type ScheduledTask } from "node-cron";

import { errorMessage, log } from "./logger.js";
import { isRunning, runRetention } from "./purge/runner.js";
import { getPolicy } from "./state.js";
import type { Policy } from "./types.js";

let task: ScheduledTask | null = null;
let scheduledFor: { cron: string; timezone: string } | null = null;

export function schedulerStatus(): { enabled: boolean; cron: string | null; timezone: string | null } {
  return {
    enabled: task !== null,
    cron: scheduledFor?.cron ?? null,
    timezone: scheduledFor?.timezone ?? null,
  };
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  scheduledFor = null;
}

/** Idempotent: re-applying an unchanged schedule leaves the existing task alone. */
export function applySchedule(policy: Policy = getPolicy()): void {
  const { enabled, cron: expression, timezone } = policy.schedule;

  if (!enabled) {
    if (task) log.info("scheduler disabled");
    stopScheduler();
    return;
  }

  if (!cron.validate(expression)) {
    log.error("invalid cron expression, scheduler not started", expression);
    stopScheduler();
    return;
  }

  if (scheduledFor && scheduledFor.cron === expression && scheduledFor.timezone === timezone) return;

  stopScheduler();
  task = cron.schedule(
    expression,
    () => {
      if (isRunning()) {
        log.warn("skipping scheduled run: a run is already in progress");
        return;
      }
      runRetention({ trigger: "schedule" }).catch((e) => log.error("scheduled run failed", errorMessage(e)));
    },
    { timezone },
  );
  scheduledFor = { cron: expression, timezone };
  log.info("scheduler armed", { cron: expression, timezone });
}
