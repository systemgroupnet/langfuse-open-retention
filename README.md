# langfuse-open-retention

Retention enforcement and a storage dashboard for **self-hosted Langfuse on the Hobby / Core setups**.

It deletes traces, observations, scores, media and — critically — the **raw ingestion event blobs that Langfuse
never cleans up on any license**, on a configurable window (15 days by default), and shows you exactly where your
disk is going.

![Screenshot](./screenshot.png)

---

> ## ⚠️ Read this before you run it
>
> **This tool permanently deletes data from your Langfuse instance. There is no undo.**
>
> - **By default it writes directly to ClickHouse**, issuing `ALTER TABLE … DROP PARTITION`
>   and `ALTER TABLE … DELETE` against Langfuse's own tables and bypassing Langfuse
>   entirely. It therefore depends on Langfuse's **internal schema**, which Langfuse is
>   free to change in any release. A Langfuse upgrade could cause it to delete the wrong
>   data or stop working. Table existence is introspected at runtime to soften this, but
>   it cannot be eliminated.
> - It also **deletes objects from object storage and rows from Postgres** — raw ingestion
>   blobs, media, batch exports, audit logs and job history — according to your policy.
> - **Back up ClickHouse, MinIO and Postgres before your first live run.**
> - It is **not affiliated with, endorsed by, or supported by Langfuse**.
>
> **Use entirely at your own risk.** This software is provided "as is", without warranty of
> any kind, express or implied. The authors accept no liability for data loss, downtime, or
> any other damage arising from its use. You alone are responsible for what it deletes.
>
> Mitigations that are on by default: it ships in **dry-run mode** and deletes nothing until
> you explicitly turn that off, and it asks you to **accept a risk notice once** before any
> live deletion is permitted — enforced server-side, so scheduled and scripted runs are
> blocked too. If you would rather nothing touched ClickHouse directly, switch the traces
> module to **Langfuse API** mode, which uses only documented public endpoints.

## Why this exists

Two separate problems on a self-hosted Core instance:

1. **No retention policy.** Traces accumulate in ClickHouse forever.
2. **Raw event blobs are never cleaned up.** Every ingested event is written to object storage as
   a JSON blob. Langfuse's own docs only say *"we recommend configuring a bucket lifecycle policy"* — there is no
   built-in cleanup. On a busy instance this is usually the single largest consumer of disk, larger
   than ClickHouse itself.

This tool addresses both, plus the Postgres tables (`audit_logs`, `job_executions`, orphaned `trace_sessions`)
that Langfuse's retention explicitly does *not* touch even on EE.

## How it deletes

| Data | Mechanism | Why |
|---|---|---|
| Traces, observations, scores | Direct ClickHouse *(default)* | Drops fully-expired monthly partitions outright — instant, no merge cost — then range-deletes the month straddling the cutoff. No API keys, covers every project in every organization. |
| Raw ingestion event blobs | Object-storage sweep | No API exists for these. Keys are `{projectId}/…` or `otel/{projectId}/…`, so per-project retention applies exactly, not via one global cutoff. |
| Media assets | Postgres `media` table → object storage | The table carries the exact key and real `content_length`, so reclaimed bytes are measured rather than estimated. Assets referenced by a dataset item are never deleted. |
| Batch exports | Object-storage sweep + row cleanup | Stale the day after download; gets its own short window. |
| Postgres housekeeping | Chunked `DELETE` | Tables no Langfuse licence ever prunes. |

**Why ClickHouse mode is the default.** This tool exists for installs *without* an
Enterprise licence — and on those, organization-scoped API keys are unavailable
(they need the `admin-api` entitlement). Without them the API path cannot mint its
own project keys, so it would purge nothing until someone pasted in a key per
project. A default that does nothing out of the box is not a default.

Only the traces module has a choice of mechanism. Everything else already works
without the API, so switching modes never changes what gets cleaned — object
storage included.

**The alternative: API mode.** Policy → Modules → Traces → Deletion method →
*Langfuse API*. This calls Langfuse's own `DELETE /api/public/traces`, so its worker
performs exactly the cleanup the Enterprise retention job does, with zero coupling
to the ClickHouse schema. It needs a project-scoped key per project
(`LANGFUSE_PROJECT_KEYS`), which project settings provide on every plan. Choose it
if schema independence matters more to you than setup cost.

**Nothing assumes a schema.** Table existence is introspected at runtime (`blob_storage_file_log` was called
`event_log` on older v3 builds and dropped in v4), so an upgrade degrades gracefully rather than erroring.

## Install

Clone this repo next to your Langfuse `docker-compose.yml`:

```bash
git clone <this repo> langfuse-open-retention
```

Add to the `.env` your Langfuse stack already uses:

```bash
RETENTION_ADMIN_PASSWORD=<a strong password>
RETENTION_COOKIE_SECRET=$(openssl rand -hex 32)
```

That is the whole required configuration. No API keys: the default deletion path
talks to ClickHouse, Postgres and object storage directly. Add keys only if you
switch the traces module to API mode — see
[API keys](#api-keys-which-kind-and-what-core-actually-allows).

Then:

```bash
docker compose \
  -f docker-compose.yml \
  -f langfuse-open-retention/docker-compose.retention.yml \
  up -d --build
```

Compose resolves the build context against the directory of the **first** `-f`
file, so the default assumes this repo sits in your Langfuse folder under its own
name. Set `RETENTION_BUILD_CONTEXT` if it lives elsewhere, or set `RETENTION_IMAGE`
to a prebuilt image and drop `--build`.

Dashboard on **http://127.0.0.1:3050** (loopback by default — it deletes data).
Reach it over an SSH tunnel rather than publishing it:

```bash
ssh -L 3050:127.0.0.1:3050 user@your-server
```

### Configuration model

Nothing in the compose file should need editing. Every setting resolves in three
tiers:

```
${RETENTION_X:-${X:-stock-default}}
 │               │     └─ works out of the box on an unmodified Langfuse compose
 │               └─ picks up what your stack already defines in the same .env
 └─ set only when the retention service needs a different value
```

So if your `.env` already sets `DATABASE_URL`, the retention service inherits it.
If your service names differ from the stock compose and those values live in the
compose file rather than the `.env`, set the `RETENTION_*` override instead:

```bash
RETENTION_DATABASE_URL=postgresql://postgres:postgres@langfuse-postgres:5432/postgres
RETENTION_CLICKHOUSE_URL=http://clickhouse:8123
RETENTION_S3_ENDPOINT=http://langfuse-minio:9000
```

`.env.example` lists every override.

> **One trap worth knowing.** Do not point `RETENTION_S3_ENDPOINT` at your
> `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT` or `LANGFUSE_S3_BATCH_EXPORT_ENDPOINT`.
> Langfuse signs browser upload URLs with those, so they are frequently set to a
> host-facing address like `http://localhost:9090`, which resolves to the
> container itself from inside the network. Use the address `langfuse-worker`
> uses for **event** uploads. The compose file deliberately does not inherit the
> media or export endpoints for this reason.

There is no `depends_on`: service names differ between deployments and cannot come
from the environment. The service starts regardless and reports any unreachable
dependency in the dashboard header.

### API keys: which kind, and what Core actually allows

Langfuse has two kinds of key, both shaped `pk-lf-…` / `sk-lf-…`:

| | Project key | Organization key |
|---|---|---|
| Created in | **Project** Settings → API Keys | **Organization** Settings → API Keys |
| Authenticates as | one project | a whole organization |
| Lets this tool | delete that project's traces | enumerate its projects and mint project keys |
| Available on | every plan, Core included | **Enterprise only** |

> **Organization keys are Enterprise-gated.** The Organization Settings → API Keys
> tab is rendered only with the `admin-api` entitlement, which the `oss` plan does
> not carry, so on a self-hosted Core install it does not appear at all. If that is
> you — and it probably is, since this tool exists for Core installs — use one of
> the two options below and ignore `LANGFUSE_ORG_KEYS` entirely.

**Option A — a project key per project.** Only needed if you switch the traces
module to API mode, for its schema independence. Create a key under each project's
own settings, then:

```bash
LANGFUSE_PROJECT_KEYS='{"<projectId>":{"publicKey":"pk-lf-...","secretKey":"sk-lf-..."}}'
```

Project ids are listed in the dashboard's Projects table, which works with no keys
configured at all — so start the service first, read the ids off it, then fill this
in. Scales with project count; organizations are irrelevant on this path.

**Option B — direct ClickHouse mode.** The default, so there is nothing to do. No
keys, and it covers every project in every organization uniformly. Object storage
is still handled, by the blob and media modules, which never use the API.

`LANGFUSE_ORG_KEYS` (one entry per organization id) and the
`LANGFUSE_ORG_PUBLIC_KEY`/`_SECRET_KEY` shorthand remain supported for Enterprise
installs, where the tool can mint its own project keys. An organization key only
ever sees its own organization, so a multi-org Enterprise instance needs one per
organization.

### Coverage is never silent

Projects are discovered from **Postgres**, not the API, so every project in every
organization appears in the dashboard whether or not a key exists for it. A project
without a usable key is skipped during an API-mode run, flagged `missing` in the
Projects table, named in a banner, and the run finishes `partial` rather than `ok`.

### If your stack bind-mounts its data

`docker system df` only reports **named volumes**. If your compose mounts host
paths instead (`/mnt/data/langfuse/clickhouse/_data:/var/lib/clickhouse`), point
the tool at those directories to measure them, and at the parent to mount
read-only:

```bash
RETENTION_HOSTFS_PATH=/mnt/data/langfuse
RETENTION_DISK_PATHS=ClickHouse=/hostfs/clickhouse/_data,MinIO=/hostfs/minio/_data
RETENTION_DOCKER_STATS_ENABLED=false
```

Paths are as seen *inside* the container, under `/hostfs`. This also reports free
space on that filesystem — usually the number you actually care about.

Data directories are owned by the uid of the service that wrote them, so the
entrypoint joins each directory's group at start-up; a ClickHouse `0750` directory
becomes readable that way. A Postgres data directory is `0700` and readable by
nobody else — leave it out, since `pg_database_size()` already reports it exactly.
Any directory that cannot be fully read is labelled as a lower bound rather than
reported as a smaller number.

## Using it

**The tool ships in dry-run mode.** Runs report what they *would* delete and touch nothing. That is deliberate:
look at a preview before arming it.

1. **Storage** — where disk is actually going: Docker volume sizes straight from the daemon, ClickHouse tables
   with compression ratios, object storage broken down by bucket and prefix, the 20 largest Postgres tables. Also
   the in-flight deletion backlog (`pending_deletions`, running ClickHouse mutations), which is the difference
   between *retention ran* and *retention worked*.
2. **Policy** — the default window, per-project overrides, per-module settings and the schedule.
   **Preview (dry run)** is safe at any time.
3. To go live: turn off **Dry-run mode**, **Save policy**, then **Run now** and confirm.
4. **Runs** — every run with a per-module breakdown of what happened.

Scheduled runs are on by default at `0 3 * * *` UTC and obey the same dry-run flag, so the scheduler stays inert
until you arm it.

### Retention windows

- Minimum **3 days**, matching Langfuse's own floor. Ingestion is asynchronous; a shorter window can delete data
  that is still being written.
- An override of `0` (or blank + excluded) means *keep this project forever*.
- Event blobs and media default to following the trace window. Give them their own if you want blobs pruned
  harder than traces — they are pure ingestion-retry scratch after a few days.
- `minGraceDays` (default 2) is a hard floor on blob deletion regardless of the window.

### What is never deleted

Datasets, dataset items, dataset run items, and any media still referenced by a dataset item. A dataset item
saved from a trace is expected to outlive that trace — this matches Langfuse's own retention semantics. Audit
logs are also excluded by default; they have a separate, much longer window under the Postgres module.

## Reclaiming disk is not instant

Worth knowing before you conclude nothing happened:

- **API trace deletion is asynchronous.** The endpoint enqueues into `pending_deletions`; `langfuse-worker`
  drains it. Watch the backlog banner on the Storage tab.
- **ClickHouse mutations are asynchronous.** `ALTER … DELETE` marks rows; space returns as parts merge.
  `SELECT * FROM system.mutations WHERE is_done = 0`. Partition drops, by contrast, are immediate.
- **Object deletions are immediate**, so the MinIO volume shrinks first.
- Volume sizes are cached (`docker system df` walks the tree with `du`). **Recalculate** forces a fresh walk.

## Configuration reference

Set these in the `.env` beside your Langfuse compose file. The compose file itself
should not need editing.

**Required**

| Variable | Purpose |
|---|---|
| `RETENTION_ADMIN_PASSWORD` | Dashboard password. Also accepted as `Authorization: Bearer` for scripting. |
| `RETENTION_COOKIE_SECRET` | Sessions survive a restart. Random per boot if unset. |

**Langfuse access**

| Variable | Default | Purpose |
|---|---|---|
| `LANGFUSE_ORG_PUBLIC_KEY` / `_SECRET_KEY` | — | Org-scoped key: project discovery + key provisioning. |
| `LANGFUSE_PROJECT_KEYS` | `{}` | Explicit per-project keys as JSON, instead of an org key. |
| `LANGFUSE_AUTO_PROVISION_KEYS` | `true` | Let the tool mint its own project keys. |
| `RETENTION_LANGFUSE_BASE_URL` | `http://langfuse-web:3000` | Internal address of langfuse-web. |

**Overrides for a customised stack** — each falls back to your stack's own value, then to the stock default

| Variable | Falls back to | Stock default |
|---|---|---|
| `RETENTION_DATABASE_URL` | `DATABASE_URL` | `postgresql://postgres:postgres@postgres:5432/postgres` |
| `RETENTION_CLICKHOUSE_URL` | `CLICKHOUSE_URL` | `http://clickhouse:8123` |
| `RETENTION_S3_ENDPOINT` | `LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT` | `http://minio:9000` |
| `RETENTION_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | the matching `..._EVENT_UPLOAD_...` | `minio` / `miniosecret` |
| `RETENTION_CLICKHOUSE_CLUSTER_NAME` | — | *(empty: single-node)* |

`CLICKHOUSE_USER` / `_PASSWORD` / `_DB` and every `LANGFUSE_S3_*_BUCKET` / `_PREFIX`
are inherited directly, since they are the same wherever the service lives.

**Storage reporting**

| Variable | Default | Purpose |
|---|---|---|
| `RETENTION_HOSTFS_PATH` | `/etc/hostname` (inert) | Host directory to mount read-only at `/hostfs`. |
| `RETENTION_DISK_PATHS` | — | `Label=/hostfs/path` pairs, comma-separated, to measure. |
| `RETENTION_DOCKER_SOCKET` | `/var/run/docker.sock` | Set to `/dev/null` to withhold it. |
| `RETENTION_DOCKER_STATS_ENABLED` | `true` | Named-volume sizes via the Docker socket. |
| `RETENTION_DOCKER_STATS_CACHE_SECONDS` | `900` | How long a size walk is cached. |

**Placement**

| Variable | Default | Purpose |
|---|---|---|
| `RETENTION_BUILD_CONTEXT` | `./langfuse-open-retention` | Path to this repo, resolved against your Langfuse directory. |
| `RETENTION_IMAGE` | `langfuse-open-retention:latest` | Use a prebuilt image instead. |
| `RETENTION_PORT` / `RETENTION_BIND_IP` | `3050` / `127.0.0.1` | Host binding. Loopback by default. |
| `RETENTION_DATA_VOLUME` | `langfuse_retention_data` | Where policy and run history live. |
| `RETENTION_CONTAINER_NAME` / `RETENTION_MEM_LIMIT` | `langfuse-retention` / `512m` | |
| `RETENTION_AUTH_DISABLED` | `false` | Trusted-network escape hatch. |
| `RETENTION_LOG_LEVEL` | `info` | |

## HTTP API

Everything the dashboard does is a plain endpoint. Authenticate with
`Authorization: Bearer $RETENTION_ADMIN_PASSWORD`.

```
GET    /api/status                  connectivity, versions, scheduler, active run
GET    /api/policy
PUT    /api/policy                  validated; rejects windows under 3 days
GET    /api/projects                resolved windows + expired counts per project
GET    /api/storage[?refresh=true]  storage snapshot
POST   /api/runs                    {"mode":"preview"}
POST   /api/runs                    {"mode":"live","confirm":"DELETE"}
GET    /api/runs
GET    /api/runs/:id
```

A live run additionally requires the saved policy to have dry-run turned off — one flag alone can never trigger
deletion.

## Security notes

- The Docker socket is mounted **read-only** and used only for `GET /system/df`. Drop that volume line if you
  would rather not expose it; volume sizes then show as unavailable and everything else still works.
- The container runs as a non-root user.
- Session cookies are `HttpOnly`/`SameSite=Lax` with no `Secure` flag, since this normally sits on plain HTTP
  inside a private network. Put it behind a TLS-terminating proxy before exposing it.

## Verified against

Built and tested end-to-end against a real **Langfuse v3.225.7** stack (the official `docker-compose.yml`,
with ClickHouse 26.8, Postgres 17, MinIO and Redis), seeded with traces spread across several months:

| Check | Result |
|---|---|
| Dry run counts | 80 traces seeded, 40 past a 15-day window → reported exactly 40 |
| API-mode live purge | traces/observations/scores 80 → 40; `pending_deletions` drained by the worker |
| Blob cascade | MinIO objects 240 → 120, i.e. the worker removed the deleted traces' blobs |
| ClickHouse-mode purge | partition `202602` dropped whole; `202608` emptied by mutation; `202609` untouched (180 → 80 traces) |
| Media purge | expired unreferenced asset deleted from MinIO *and* Postgres |
| Dataset protection | expired asset referenced by a dataset item kept in both |
| Live-run guards | rejected without `confirm: "DELETE"`, and rejected while the policy says dry-run |
| Storage dashboard | volume sizes via the Docker socket, scoped to the Langfuse compose project |

The ClickHouse DDL this tool relies on (partition keys, `is_deleted`, `blob_storage_file_log`) was read from the
v3.225.7 migrations rather than assumed, and table existence is introspected at runtime regardless.

`npm test` covers the pure logic: object-key parsing for both event layouts, grace-period clamping, the
keep-forever guard on instance-wide partition drops, byte estimation, and policy validation.

## Development

```bash
npm install
npm run build
RETENTION_ADMIN_PASSWORD=dev RETENTION_DATA_DIR=./data npm start
npm test
```

Layout:

```
src/clients/    clickhouse · postgres · s3 · langfuse api · docker socket
src/purge/      one module per data class, plus the run orchestrator
src/storage/    the storage snapshot
src/routes/     HTTP API and policy validation
public/         dashboard (no build step, no framework)
```

Adding a data class is one file in `src/purge/` exporting `(ctx) => Promise<ModuleResult>`, registered in the
`MODULES` array in `runner.ts`. Every module must honour `ctx.policy.dryRun`.

## Licence and liability

Provided **as is**, without warranty of any kind, express or implied, including but not
limited to the warranties of merchantability, fitness for a particular purpose and
non-infringement. In no event shall the authors or copyright holders be liable for any
claim, damages or other liability, whether in an action of contract, tort or otherwise,
arising from, out of, or in connection with this software or its use.

This project is independent. It is not affiliated with, endorsed by, or supported by
Langfuse. "Langfuse" is the trademark of its respective owner and is used here only to
describe what this tool interoperates with.
