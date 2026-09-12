import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts reads the environment at import time; give it the minimum it needs
// before anything pulls it in transitively.
process.env.RETENTION_ADMIN_PASSWORD ??= "test";
process.env.RETENTION_DATA_DIR ??= "./.testdata";

const { projectIdFromEventKey, blobCutoffFor } = await import("./purge/eventBlobs.js");
const { daysAgo, formatBytes, globalSafeCutoff, isSingleOrg } = await import("./purge/context.js");
const { estimateBytes } = await import("./purge/estimate.js");
const { validatePolicy, ValidationError } = await import("./routes/policy-validation.js");
const { parseDiskPaths } = await import("./storage/disk.js");
const { DEFAULT_POLICY } = await import("./state.js");

/* ── object-key parsing ─────────────────────────────────────────────────── */

test("parses the project id out of both event key layouts", () => {
  assert.equal(
    projectIdFromEventKey("events/cm0abc/trace/body123/evt456.json", "events/"),
    "cm0abc",
    "standard layout",
  );
  assert.equal(
    projectIdFromEventKey("events/otel/cm0abc/2026/09/12/07/30/evt456.json", "events/"),
    "cm0abc",
    "otel layout puts the project id one segment deeper",
  );
  assert.equal(projectIdFromEventKey("cm0abc/trace/body/evt.json", ""), "cm0abc", "empty prefix");
  assert.equal(
    projectIdFromEventKey("nested/deep/events/cm0abc/trace/b/e.json", "nested/deep/events/"),
    "cm0abc",
    "multi-segment prefix",
  );
});

test("returns undefined rather than guessing on unrecognised keys", () => {
  assert.equal(projectIdFromEventKey("events/loose-file.json", "events/"), undefined);
  assert.equal(projectIdFromEventKey("", "events/"), undefined);
  // A key that does not carry the expected prefix is not silently reinterpreted.
  assert.equal(projectIdFromEventKey("otel/cm0abc/2026/09/12/x.json", "events/"), "cm0abc");
});

/* ── retention arithmetic ───────────────────────────────────────────────── */

const now = new Date("2026-09-12T12:00:00.000Z");

/** A ProjectPlan fixture; org defaults to a single shared organization. */
function plan(over: Partial<{ id: string; name: string; orgId: string | null; orgName: string | null; retentionDays: number | null; cutoff: Date | null; excluded: boolean }> = {}) {
  return {
    id: "p",
    name: "p",
    orgId: "org1",
    orgName: "Org One",
    retentionDays: 15,
    langfuseRetentionDays: null,
    cutoff: daysAgo(15, now),
    excluded: false,
    ...over,
  };
}

function ctxWith(overrides: Partial<Parameters<typeof blobCutoffFor>[0]>) {
  return {
    policy: structuredClone(DEFAULT_POLICY),
    projects: [],
    active: [],
    startedAt: now,
    ...overrides,
  } as Parameters<typeof blobCutoffFor>[0];
}

test("blob retention follows the trace window when it has none of its own", () => {
  const ctx = ctxWith({});
  ctx.policy.modules.eventBlobs.retentionDays = null;
  const cutoff = blobCutoffFor(ctx, plan({ retentionDays: 30, cutoff: daysAgo(30, now) }));
  assert.equal(cutoff?.toISOString(), daysAgo(30, now).toISOString());
});

test("the grace period is a hard floor, however aggressive the window", () => {
  const ctx = ctxWith({});
  ctx.policy.modules.eventBlobs.retentionDays = 1;
  ctx.policy.modules.eventBlobs.minGraceDays = 5;
  const cutoff = blobCutoffFor(ctx, plan({ retentionDays: 1, cutoff: daysAgo(1, now) }));
  assert.equal(
    cutoff?.toISOString(),
    daysAgo(5, now).toISOString(),
    "a 1-day window must not beat a 5-day grace period",
  );
});

test("a project that keeps data forever yields no blob cutoff", () => {
  const ctx = ctxWith({});
  ctx.policy.modules.eventBlobs.retentionDays = null;
  const cutoff = blobCutoffFor(ctx, plan({ retentionDays: null, cutoff: null, excluded: true }));
  assert.equal(cutoff, null);
});

test("instance-wide operations are disabled when any project keeps data forever", () => {
  const keepForever = plan({ id: "b", name: "b", retentionDays: null, cutoff: null, excluded: true });
  const expiring = plan({ id: "a", name: "a" });

  assert.equal(
    globalSafeCutoff(ctxWith({ projects: [expiring, keepForever], active: [expiring] })),
    null,
    "dropping a whole partition would destroy the retained project's rows too",
  );

  const longer = plan({ id: "c", name: "c", retentionDays: 90, cutoff: daysAgo(90, now) });
  assert.equal(
    globalSafeCutoff(ctxWith({ projects: [expiring, longer], active: [expiring, longer] }))?.toISOString(),
    daysAgo(90, now).toISOString(),
    "the safe cutoff is the most generous window, not the strictest",
  );
});

/* ── byte estimation ────────────────────────────────────────────────────── */

test("byte estimates scale with the expired fraction and never exceed the table", () => {
  const footprint = { table: "traces", rows: 1000, bytesOnDisk: 10_000, uncompressedBytes: 40_000 };
  assert.equal(estimateBytes(footprint, 250), 2500);
  assert.equal(estimateBytes(footprint, 5000), 10_000, "clamped at the whole table");
  assert.equal(estimateBytes(footprint, 0), 0);
  assert.equal(estimateBytes(undefined, 100), 0, "no footprint means no claim");
  assert.equal(estimateBytes({ ...footprint, rows: 0 }, 100), 0, "an empty table cannot be divided by");
});

test("byte formatting stays readable across magnitudes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 ** 3 * 2.5), "2.5 GiB");
  assert.equal(formatBytes(-1), "n/a", "modules that cannot measure bytes report -1");
});

/* ── policy validation ──────────────────────────────────────────────────── */

test("accepts a well-formed policy and normalises it", () => {
  const policy = validatePolicy({
    ...DEFAULT_POLICY,
    defaultRetentionDays: 15,
    projectOverrides: { proj1: 30, proj2: 0 },
  });
  assert.equal(policy.defaultRetentionDays, 15);
  assert.equal(policy.projectOverrides.proj1, 30);
  assert.equal(policy.projectOverrides.proj2, null, "0 normalises to keep-forever");
});

test("refuses windows below the 3-day floor Langfuse itself enforces", () => {
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, defaultRetentionDays: 2 }), ValidationError);
  assert.throws(
    () => validatePolicy({ ...DEFAULT_POLICY, projectOverrides: { proj1: 1 } }),
    ValidationError,
    "overrides are held to the same floor as the default",
  );
});

test("refuses a malformed schedule instead of silently disarming it", () => {
  assert.throws(
    () => validatePolicy({ ...DEFAULT_POLICY, schedule: { enabled: true, cron: "not a cron", timezone: "UTC" } }),
    ValidationError,
  );
});

test("rejects project ids that could be smuggled into an identifier position", () => {
  assert.throws(
    () => validatePolicy({ ...DEFAULT_POLICY, projectOverrides: { "'; DROP TABLE traces; --": 30 } }),
    ValidationError,
  );
});

test("unknown deletion methods fall back to the safe one", () => {
  const policy = validatePolicy({
    ...DEFAULT_POLICY,
    modules: { ...DEFAULT_POLICY.modules, traces: { ...DEFAULT_POLICY.modules.traces, mode: "rm -rf" } },
  });
  assert.equal(policy.modules.traces.mode, "api");
});

test("a partial policy body keeps the defaults for everything it omits", () => {
  const policy = validatePolicy({ defaultRetentionDays: 20 });
  assert.equal(policy.defaultRetentionDays, 20);
  assert.equal(policy.modules.eventBlobs.minGraceDays, DEFAULT_POLICY.modules.eventBlobs.minGraceDays);
  assert.equal(policy.modules.batchExports.retentionDays, DEFAULT_POLICY.modules.batchExports.retentionDays);
});

/* ── disk path configuration ────────────────────────────────────────────── */

test("parses labelled and bare disk paths, tolerating YAML folding whitespace", () => {
  // A YAML folded scalar joins lines with spaces, so entries arrive padded.
  const raw = "ClickHouse=/hostfs/clickhouse/_data, ClickHouse logs=/hostfs/clickhouse-logs/_data, MinIO=/hostfs/minio/_data";
  assert.deepEqual(parseDiskPaths(raw), [
    { label: "ClickHouse", path: "/hostfs/clickhouse/_data" },
    { label: "ClickHouse logs", path: "/hostfs/clickhouse-logs/_data" },
    { label: "MinIO", path: "/hostfs/minio/_data" },
  ]);
});

test("a bare path is labelled by its last segment", () => {
  assert.deepEqual(parseDiskPaths("/hostfs/minio/_data"), [
    { label: "_data", path: "/hostfs/minio/_data" },
  ]);
  assert.deepEqual(parseDiskPaths("/hostfs/minio/"), [{ label: "minio", path: "/hostfs/minio/" }]);
});

test("an unset or empty disk-path setting disables the feature rather than erroring", () => {
  assert.deepEqual(parseDiskPaths(undefined), []);
  assert.deepEqual(parseDiskPaths(""), []);
  assert.deepEqual(parseDiskPaths("  ,  ,"), []);
});

/* ── multi-organization coverage ────────────────────────────────────────── */

test("detects whether the instance has one organization or several", () => {
  assert.equal(isSingleOrg([{ orgId: "org1" }, { orgId: "org1" }]), true);
  assert.equal(isSingleOrg([{ orgId: "org1" }, { orgId: "org2" }]), false);
  assert.equal(isSingleOrg([]), true, "an empty instance needs no disambiguation");
  assert.equal(
    isSingleOrg([{ orgId: null }, { orgId: "org1" }]),
    true,
    "projects with unknown org (API-only discovery) must not force multi-org handling",
  );
  assert.equal(isSingleOrg([{ orgId: null }, { orgId: null }]), true);
});
