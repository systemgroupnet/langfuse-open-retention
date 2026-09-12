/* Langfuse Retention dashboard — no framework, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  policy: null,
  projects: [],
  expiredRows: {},
  storage: null,
  status: null,
  orgsWithoutKeys: [],
  runs: [],
  pollTimer: null,
};

/* ── helpers ────────────────────────────────────────── */

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes < 0) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatCount(n) {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    ...options,
    // Only declare a JSON body when there actually is one. Announcing
    // `Content-Type: application/json` on a bodyless POST makes the server try to
    // parse an empty payload and reject the request outright.
    headers: { ...(hasBody ? { "Content-Type": "application/json" } : {}), ...options.headers },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("Unauthorized");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function flash(node, message, ms = 4000) {
  node.textContent = message;
  node.hidden = false;
  setTimeout(() => {
    node.hidden = true;
  }, ms);
}

/* ── auth ───────────────────────────────────────────── */

function showLogin() {
  $("#login").hidden = false;
  $("#risk-gate").hidden = true;
  $("#app").hidden = true;
  clearInterval(state.pollTimer);
}

/**
 * First-run risk notice.
 *
 * Acceptance is stored server-side, per installation, so it is a statement about
 * this deployment rather than a banner each browser dismisses separately. Live
 * deletion stays blocked until it is accepted — the server enforces that too, so
 * the dialog is a gate rather than decoration.
 */
function showRiskGate() {
  $("#login").hidden = true;
  $("#app").hidden = true;
  $("#risk-gate").hidden = false;
}

$("#risk-confirm").addEventListener("change", (event) => {
  $("#risk-accept").disabled = !event.target.checked;
});

$("#risk-accept").addEventListener("click", async () => {
  const button = $("#risk-accept");
  button.disabled = true;
  try {
    await api("/api/acknowledge-risk", { method: "POST", body: { confirm: "I UNDERSTAND" } });
    $("#risk-gate").hidden = true;
    await enterApp();
  } catch (e) {
    button.disabled = false;
    flash($("#risk-error"), e.message, 8000);
  }
});

async function enterApp() {
  $("#login").hidden = true;
  $("#risk-gate").hidden = true;
  $("#app").hidden = false;
  await refreshAll();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshStatus, 5000);
}

async function boot() {
  const session = await fetch("/api/session").then((r) => r.json());
  if (!session.authenticated) {
    showLogin();
    if (!session.authConfigured) {
      flash($("#login-error"), "Server has no RETENTION_ADMIN_PASSWORD set.", 30_000);
    }
    return;
  }
  if (!session.riskAcknowledged) {
    showRiskGate();
    return;
  }
  await enterApp();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login-password").value = "";
    await boot();
  } catch (e) {
    flash($("#login-error"), e.message);
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

/* ── tabs ───────────────────────────────────────────── */

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  }),
);

/* ── status header ──────────────────────────────────── */

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    return;
  }
  const s = state.status;

  const version = s.langfuse.version ? `Langfuse ${s.langfuse.version}` : "Langfuse version unknown";
  const schedule = s.scheduler.enabled ? `cron ${s.scheduler.cron} (${s.scheduler.timezone})` : "no schedule";
  $("#instance-line").textContent = `${s.langfuse.baseUrl} · ${version} · ${schedule}`;

  const badge = $("#mode-badge");
  const dryRun = state.policy?.dryRun ?? true;
  badge.textContent = s.run.active ? "RUN IN PROGRESS" : dryRun ? "DRY RUN" : "LIVE DELETES";
  badge.className = `badge${!dryRun && !s.run.active ? " live" : ""}`;

  const checks = [
    ["Langfuse", s.langfuse.ok, s.langfuse.error, false],
    ["ClickHouse", s.clickhouse.ok, s.clickhouse.error, false],
    ["Postgres", s.postgres.ok, s.postgres.error, false],
    ["MinIO", s.objectStorage.events.ok, s.objectStorage.events.error, false],
    // A feature switched off on purpose is not a failure, so it reads neutral
    // rather than red — otherwise a healthy instance looks permanently broken.
    ["Docker", s.docker.ok, s.docker.error, Boolean(s.docker.disabled)],
  ];
  $("#health-pills").replaceChildren(
    ...checks.map(([name, ok, error, disabled]) =>
      el(
        "span",
        {
          class: `pill ${disabled ? "" : ok ? "up" : "down"}`.trim(),
          title: error || `${name} reachable`,
        },
        disabled ? `${name} off` : name,
      ),
    ),
  );

  // A run started elsewhere (or on a schedule) should surface without a manual refresh.
  if (s.run.active) $("#runs-meta").textContent = "A run is in progress…";
}

/* ── storage tab ────────────────────────────────────── */

function statCard(label, value, sub, available = true) {
  return el(
    "div",
    { class: `stat${available ? "" : " unavailable"}` },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    el("div", { class: "sub" }, sub),
  );
}

function barList(entries, { hotMatcher } = {}) {
  const max = Math.max(1, ...entries.map((e) => Math.max(0, e.bytes)));
  return el(
    "div",
    { class: "bars" },
    entries.map((entry) => {
      const pct = Math.max(0, entry.bytes) / max;
      const hot = hotMatcher?.(entry) ?? false;
      return el(
        "div",
        { class: "bar-row" },
        el("div", { class: "bar-name", title: entry.name }, entry.name),
        el(
          "div",
          { class: "bar-size" },
          formatBytes(entry.bytes),
          entry.count != null ? ` · ${formatCount(entry.count)}` : "",
        ),
        el(
          "div",
          { class: "bar-track" },
          el("div", { class: `bar-fill${hot ? " hot" : ""}`, style: `width:${(pct * 100).toFixed(1)}%` }),
        ),
        entry.detail ? el("div", { class: "bar-detail" }, entry.detail) : null,
      );
    }),
  );
}

function breakdownCard(title, section, options = {}) {
  if (!section.available) {
    return el(
      "div",
      { class: "card" },
      el("h3", {}, title),
      el("p", { class: "hint" }, section.error || "Unavailable."),
    );
  }
  if (section.entries.length === 0) {
    return el("div", { class: "card" }, el("h3", {}, title), el("p", { class: "hint" }, "Nothing stored yet."));
  }
  return el("div", { class: "card" }, el("h3", {}, title), barList(section.entries, options));
}

function renderStorage() {
  const s = state.storage;
  if (!s) return;

  $("#storage-meta").textContent =
    `Measured ${formatDate(s.generatedAt)} in ${formatDuration(s.tookMs)}. ` +
    `Object-storage and volume sizes are cached; use Recalculate to force a fresh walk.`;

  const compression =
    s.clickhouse.total > 0 ? `${(s.clickhouse.uncompressedTotal / s.clickhouse.total).toFixed(1)}x compressed` : "";

  const VOLUME_TITLES = {
    docker: "Docker volumes",
    disk: "Data directories",
    both: "Volumes & data dirs",
    none: "Data on disk",
  };

  // Free space is the number that matters when a disk is filling up, so it leads
  // when the tool has been pointed at the data directories.
  const fsCards = (s.filesystems || []).map((fs) =>
    statCard(
      "Free space",
      formatBytes(fs.freeBytes),
      `${fs.usedPercent.toFixed(0)}% used of ${formatBytes(fs.totalBytes)} · ${fs.path}`,
    ),
  );

  $("#storage-cards").replaceChildren(
    ...fsCards,
    statCard(
      VOLUME_TITLES[s.volumes.source] || VOLUME_TITLES.none,
      s.volumes.available ? formatBytes(s.volumes.total) : "unavailable",
      s.volumes.available
        ? `${s.volumes.entries.length} location(s) measured`
        : "set RETENTION_DISK_PATHS or mount docker.sock",
      s.volumes.available,
    ),
    statCard(
      "ClickHouse",
      s.clickhouse.available ? formatBytes(s.clickhouse.total) : "unavailable",
      s.clickhouse.available ? compression : s.clickhouse.error,
      s.clickhouse.available,
    ),
    statCard(
      "Object storage",
      s.objectStorage.available ? formatBytes(s.objectStorage.total) : "unavailable",
      s.objectStorage.available ? `${formatCount(s.objectStorage.objectCount)} objects` : s.objectStorage.error,
      s.objectStorage.available,
    ),
    statCard(
      "Postgres",
      s.postgres.available ? formatBytes(s.postgres.total) : "unavailable",
      s.postgres.available ? `${s.postgres.entries.length} largest tables shown` : s.postgres.error,
      s.postgres.available,
    ),
  );

  const banner = $("#backlog-banner");
  const { pendingDeletions, runningMutations } = s.backlog;
  if (pendingDeletions > 0 || runningMutations > 0) {
    banner.hidden = false;
    banner.textContent =
      `Deletion work still in flight: ${formatCount(pendingDeletions ?? 0)} queued trace deletion(s) ` +
      `awaiting langfuse-worker, ${formatCount(runningMutations ?? 0)} running ClickHouse mutation(s). ` +
      `Disk is reclaimed as these drain.`;
  } else {
    banner.hidden = true;
  }

  $("#storage-breakdowns").replaceChildren(
    breakdownCard(VOLUME_TITLES[s.volumes.source] || VOLUME_TITLES.none, s.volumes, {
      hotMatcher: (e) => /clickhouse|minio/i.test(e.name),
    }),
    breakdownCard("Object storage by bucket and prefix", s.objectStorage, {
      // The raw-events prefix is the one with no cleanup of its own; call it out.
      hotMatcher: (e) => /event/i.test(e.detail || ""),
    }),
    breakdownCard("ClickHouse tables", s.clickhouse, {
      hotMatcher: (e) => ["traces", "observations", "scores"].includes(e.name),
    }),
    breakdownCard("Postgres tables", s.postgres, {
      hotMatcher: (e) => ["audit_logs", "job_executions", "automation_executions", "trace_sessions"].includes(e.name),
    }),
  );
}

async function refreshStorage(force = false) {
  const button = $("#refresh-storage");
  button.disabled = true;
  button.textContent = force ? "Recalculating…" : "Loading…";
  try {
    state.storage = await api(`/api/storage${force ? "?refresh=true" : ""}`);
    renderStorage();
  } finally {
    button.disabled = false;
    button.textContent = "Recalculate";
  }
}

$("#refresh-storage").addEventListener("click", () => refreshStorage(true));

/* ── policy tab ─────────────────────────────────────── */

const MODULE_SPECS = [
  {
    key: "traces",
    title: "Traces, observations and scores",
    description:
      "Deletes expired traces and everything hanging off them. Direct ClickHouse mode needs no API keys and " +
      "covers every project in every organization — the default, because organization keys are Enterprise-only. " +
      "API mode instead calls Langfuse's own DELETE /api/public/traces, avoiding any schema coupling, but needs " +
      "a project-scoped key per project.",
    fields: [
      {
        key: "mode",
        label: "Deletion method",
        type: "select",
        options: [
          ["clickhouse", "Direct ClickHouse (no keys, default)"],
          ["api", "Langfuse API (needs a key per project)"],
        ],
      },
      { key: "batchSize", label: "Trace IDs per request", type: "number", min: 1, max: 1000 },
      { key: "maxTracesPerRun", label: "Max traces per run", type: "number", min: 1 },
      { key: "dropWholePartitions", label: "Drop fully-expired partitions", type: "bool" },
    ],
  },
  {
    key: "eventBlobs",
    title: "Raw ingestion event blobs",
    description:
      "Every ingested event is written to object storage as JSON and nothing in Langfuse ever removes it. " +
      "On a busy instance this is usually the largest single consumer of disk.",
    fields: [
      { key: "retentionDays", label: "Retention (blank = follow trace window)", type: "number", min: 1, nullable: true },
      { key: "minGraceDays", label: "Minimum grace period (days)", type: "number", min: 0 },
      { key: "maxObjectsPerRun", label: "Max objects per run", type: "number", min: 1 },
      { key: "pruneClickhouseIndex", label: "Also prune the ClickHouse blob index", type: "bool" },
    ],
  },
  {
    key: "media",
    title: "Media assets",
    description:
      "Multimodal uploads attached to traces and observations. Assets still referenced by a dataset item are " +
      "never deleted — datasets outlive the traces they were captured from.",
    fields: [
      { key: "retentionDays", label: "Retention (blank = follow trace window)", type: "number", min: 1, nullable: true },
    ],
  },
  {
    key: "batchExports",
    title: "Batch export artifacts",
    description: "One-off CSV/JSON exports. Stale almost immediately, so they get their own short window.",
    fields: [{ key: "retentionDays", label: "Retention (days)", type: "number", min: 1 }],
  },
  {
    key: "postgres",
    title: "Postgres housekeeping",
    description:
      "Tables Langfuse's own retention never touches. Audit logs are excluded from it by design, so their " +
      "window is set separately here.",
    fields: [
      { key: "auditLogsDays", label: "audit_logs (days)", type: "number", min: 1, nullable: true },
      { key: "jobExecutionsDays", label: "job_executions (days)", type: "number", min: 1, nullable: true },
      { key: "automationExecutionsDays", label: "automation_executions (days)", type: "number", min: 1, nullable: true },
      { key: "orphanSessions", label: "Remove sessions with no traces left", type: "bool" },
    ],
  },
];

function moduleField(moduleKey, spec, value) {
  const id = `mod-${moduleKey}-${spec.key}`;

  if (spec.type === "bool") {
    return el(
      "label",
      { class: "switch" },
      el("input", { type: "checkbox", id, ...(value ? { checked: true } : {}) }),
      el("span", {}, spec.label),
    );
  }

  if (spec.type === "select") {
    const select = el("select", { id, class: "field-input" });
    for (const [optionValue, optionLabel] of spec.options) {
      select.append(el("option", { value: optionValue, ...(value === optionValue ? { selected: true } : {}) }, optionLabel));
    }
    return el("label", { class: "field" }, el("span", {}, spec.label), select);
  }

  return el(
    "label",
    { class: "field" },
    el("span", {}, spec.label),
    el("input", {
      type: "number",
      id,
      min: spec.min,
      max: spec.max,
      value: value ?? "",
      placeholder: spec.nullable ? "inherit" : "",
    }),
  );
}

function renderModules() {
  const modules = state.policy.modules;
  $("#modules").replaceChildren(
    ...MODULE_SPECS.map((spec) => {
      const values = modules[spec.key];
      return el(
        "div",
        { class: "module" },
        el(
          "div",
          { class: "module-head" },
          el("div", {}, el("h4", {}, spec.title), el("p", {}, spec.description)),
          el(
            "label",
            { class: "switch", style: "margin:0" },
            el("input", { type: "checkbox", id: `mod-${spec.key}-enabled`, ...(values.enabled ? { checked: true } : {}) }),
            el("span", {}, "Enabled"),
          ),
        ),
        el("div", { class: "module-fields" }, spec.fields.map((f) => moduleField(spec.key, f, values[f.key]))),
      );
    }),
  );
}

const KEY_CELLS = {
  ready: () => el("span", { class: "pill up" }, "ready"),
  provisionable: () =>
    el("span", { class: "pill", title: "The tool mints a project key on the first run." }, "on first run"),
  missing: () =>
    el("span", { class: "pill down", title: "No project-scoped key; this project will be skipped." }, "missing"),
};

function renderProjects() {
  const tbody = $("#projects-table tbody");
  if (state.projects.length === 0) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "empty" }, "No projects found.")));
    return;
  }

  tbody.replaceChildren(
    ...state.projects.map((project) => {
      const override = state.policy.projectOverrides[project.id];
      const keyCell = project.keyStatus
        ? KEY_CELLS[project.keyStatus]()
        : el("span", { class: "cell-mono" }, "n/a");

      return el(
        "tr",
        {},
        el("td", {}, project.orgName || el("span", { class: "cell-mono" }, "—")),
        el("td", {}, el("div", {}, project.name), el("div", { class: "cell-mono" }, project.id)),
        el("td", {}, project.retentionDays === null ? "keep forever" : `${project.retentionDays} days`),
        el("td", { class: "cell-mono" }, project.cutoff ? project.cutoff.slice(0, 10) : "—"),
        el("td", {}, project.expiredTraces === null ? "—" : formatCount(project.expiredTraces)),
        el(
          "td",
          {},
          el("input", {
            type: "number",
            min: "0",
            placeholder: "inherit",
            value: override === undefined ? "" : (override ?? 0),
            "data-project": project.id,
            class: "override-input",
          }),
        ),
        el("td", {}, keyCell),
      );
    }),
  );

  // Observations and scores have no meaningful per-project column of their own,
  // so the full per-table picture is summarised beneath the table.
  const parts = Object.entries(state.expiredRows)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${formatCount(n)} ${table}`);
  $("#expired-summary").textContent = parts.length
    ? `Currently expired across all projects: ${parts.join(", ")}.`
    : "Nothing is currently past its retention window.";

  // An organization with no usable key is skipped entirely in API mode. That is
  // invisible in the numbers above, so it gets stated outright.
  const warning = $("#org-coverage-warning");
  const uncovered = state.orgsWithoutKeys || [];
  if (uncovered.length > 0) {
    const names = uncovered.map((o) => o.name || o.id || "unknown").join(", ");
    warning.hidden = false;
    warning.textContent =
      `No usable API key for ${uncovered.length} organization(s): ${names}. ` +
      `Their projects are listed above but will be SKIPPED — their data will not be deleted. ` +
      `An organization key only ever sees its own organization, so add one per org via ` +
      `LANGFUSE_ORG_KEYS, or switch the traces module to direct ClickHouse mode, which needs no keys.`;
  } else {
    warning.hidden = true;
  }
}

function renderPolicy() {
  const p = state.policy;
  $("#default-days").value = p.defaultRetentionDays;
  $("#dry-run").checked = p.dryRun;
  $("#schedule-enabled").checked = p.schedule.enabled;
  $("#schedule-cron").value = p.schedule.cron;
  $("#schedule-tz").value = p.schedule.timezone;

  const cutoff = new Date(Date.now() - p.defaultRetentionDays * 86_400_000);
  $("#cutoff-hint").textContent =
    `Anything older than ${cutoff.toLocaleDateString(undefined, { dateStyle: "medium" })} is expired. ` +
    `Minimum ${state.status?.minRetentionDays ?? 3} days.`;

  $("#live-run").disabled = p.dryRun;
  $("#live-run").title = p.dryRun ? "Turn off dry-run mode and save before running live." : "";

  renderModules();
  renderProjects();
}

function collectPolicy() {
  const p = structuredClone(state.policy);
  p.defaultRetentionDays = Number($("#default-days").value);
  p.dryRun = $("#dry-run").checked;
  p.schedule.enabled = $("#schedule-enabled").checked;
  p.schedule.cron = $("#schedule-cron").value.trim();
  p.schedule.timezone = $("#schedule-tz").value.trim() || "UTC";

  p.projectOverrides = {};
  for (const input of $$(".override-input")) {
    const raw = input.value.trim();
    if (raw === "") continue;
    p.projectOverrides[input.dataset.project] = Number(raw);
  }

  for (const spec of MODULE_SPECS) {
    const target = p.modules[spec.key];
    target.enabled = $(`#mod-${spec.key}-enabled`).checked;
    for (const field of spec.fields) {
      const node = $(`#mod-${spec.key}-${field.key}`);
      if (!node) continue;
      if (field.type === "bool") target[field.key] = node.checked;
      else if (field.type === "select") target[field.key] = node.value;
      else {
        const raw = node.value.trim();
        target[field.key] = raw === "" ? (field.nullable ? null : target[field.key]) : Number(raw);
      }
    }
  }
  return p;
}

$("#save-policy").addEventListener("click", async () => {
  try {
    state.policy = await api("/api/policy", { method: "PUT", body: collectPolicy() });
    renderPolicy();
    await refreshStatus();
    flash($("#policy-ok"), "Policy saved.");
  } catch (e) {
    flash($("#policy-error"), e.message, 8000);
  }
});

async function startRun(mode) {
  const body = mode === "live" ? { mode, confirm: "DELETE" } : { mode };
  try {
    await api("/api/runs", { method: "POST", body });
    $$(".tab").find((t) => t.dataset.tab === "runs").click();
    $("#runs-meta").textContent = "Run started…";
    pollRun();
  } catch (e) {
    flash($("#policy-error"), e.message, 8000);
  }
}

$("#preview-run").addEventListener("click", () => startRun("preview"));

$("#live-run").addEventListener("click", () => {
  const days = state.policy.defaultRetentionDays;
  const confirmed = window.confirm(
    `This permanently deletes Langfuse data older than ${days} days across every project ` +
      `without an override, plus expired blobs in object storage. It cannot be undone.\n\n` +
      `Run a Preview first if you have not already. Continue?`,
  );
  if (confirmed) startRun("live");
});

/* ── runs tab ───────────────────────────────────────── */

function renderRun(run) {
  const title =
    run.status === "running"
      ? "Running…"
      : `${formatCount(run.totals.items)} item(s) · ${formatBytes(run.totals.bytes)} reclaimed`;

  return el(
    "details",
    { class: "run", ...(run.status === "running" ? { open: true } : {}) },
    el(
      "summary",
      {},
      el("span", { class: `run-status ${run.status}` }, run.status),
      el("span", { class: "badge" }, run.dryRun ? "dry run" : "live"),
      el(
        "span",
        { class: "run-summary-text" },
        `${formatDate(run.startedAt)} · ${run.trigger} · ${title}`,
      ),
      el("span", { class: "bar-size" }, formatDuration(run.durationMs)),
    ),
    el(
      "div",
      { class: "run-body" },
      run.error ? el("p", { class: "error" }, run.error) : null,
      ...run.modules.map((module) =>
        el(
          "div",
          { class: `module-result ${module.status}` },
          el(
            "h5",
            {},
            `${module.module} — ${module.status}`,
            module.items > 0 ? ` · ${formatCount(module.items)} item(s)` : "",
            module.bytes > 0 ? ` · ${formatBytes(module.bytes)}` : "",
          ),
          module.error ? el("p", { class: "error" }, module.error) : null,
          el("ul", {}, module.details.map((line) => el("li", {}, line))),
        ),
      ),
    ),
  );
}

async function refreshRuns() {
  const { runs, active } = await api("/api/runs");
  state.runs = active ? [active, ...runs.filter((r) => r.id !== active.id)] : runs;

  const list = $("#runs-list");
  if (state.runs.length === 0) {
    list.replaceChildren(el("div", { class: "empty" }, "No runs yet. Start with a Preview from the Policy tab."));
  } else {
    list.replaceChildren(...state.runs.map(renderRun));
  }

  const last = state.runs.find((r) => r.status !== "running");
  $("#runs-meta").textContent = active
    ? "A run is in progress…"
    : last
      ? `Last run ${formatDate(last.startedAt)} · ${last.status}`
      : "No completed runs yet.";

  return Boolean(active);
}

/** Follow a run to completion, then refresh the storage numbers it changed. */
async function pollRun() {
  const stillRunning = await refreshRuns();
  if (stillRunning) {
    setTimeout(pollRun, 2000);
  } else {
    await Promise.all([refreshStorage(true), refreshProjects()]);
  }
}

$("#refresh-runs").addEventListener("click", () => refreshRuns());

/* ── orchestration ──────────────────────────────────── */

async function refreshProjects() {
  const { projects, expiredRows, orgsWithoutKeys } = await api("/api/projects");
  state.projects = projects;
  state.expiredRows = expiredRows || {};
  state.orgsWithoutKeys = orgsWithoutKeys || [];
  if (state.policy) renderProjects();
}

async function refreshAll() {
  state.policy = await api("/api/policy");
  await refreshStatus();
  renderPolicy();
  await Promise.all([refreshProjects(), refreshStorage(false), refreshRuns()]);
}

boot().catch((e) => {
  console.error(e);
  showLogin();
});
