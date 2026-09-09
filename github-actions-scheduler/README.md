# github-actions-scheduler

A Cloudflare Worker that starts the GitHub Actions workflows in
`gfiuser09/Jobs-scraping-tool` at fixed IST times, replacing the `schedule:`
triggers that used to live in each workflow file.

```
Cloudflare Cron Trigger -> Worker (scheduled handler) -> GitHub REST API
  -> workflow_dispatch on main -> GitHub Actions run
```

## Schedule

Cloudflare evaluates cron expressions in **UTC only**. IST is a fixed UTC+5:30
with no daylight saving, so each UTC time maps to exactly one IST time all year.

| IST            | UTC            | Cron expression  | Workflows |
| -------------- | -------------- | ---------------- | --------- |
| 12:00 and 16:00 | 06:30 and 10:30 | `30 6,10 * * *` | the 18 non-level-5 workflows |
| 13:00 and 17:00 | 07:30 and 11:30 | `30 7,11 * * *` | `level5.yml`, `level5_sustain.yml` |

The two level 5 workflows deliberately run an hour behind the rest of the batch.

Each batch is one cron entry with an hour list rather than two separate entries,
so the Worker uses two Cron Triggers in total. The free plan allows 5 per
account. The Worker routes on `event.cron`, so one expression per batch is all
the routing needs.

## One-time setup

### 1. Create the GitHub token

A **fine-grained** personal access token at
<https://github.com/settings/personal-access-tokens/new>:

- **Resource owner**: `gfiuser09`
- **Repository access**: Only select repositories -> `Jobs-scraping-tool`
- **Repository permissions**: `Actions` -> **Read and write**
  (`Metadata` -> Read-only is added automatically and is required)

A classic token works too, with the `repo` and `workflow` scopes — but it is
valid for every repo you can reach, so the fine-grained one is preferable.

> Fine-grained tokens expire (1 year maximum). When it expires every dispatch
> starts returning HTTP 401 and no scraping runs. Worth a calendar reminder.

### 2. Deploy

```sh
cd github-actions-scheduler
npm install
npx wrangler login          # opens a browser; no password is stored on disk
npx wrangler deploy
```

### 3. Store the token as an encrypted secret

```sh
npx wrangler secret put GITHUB_TOKEN
```

Paste the token at the prompt and press Enter. It is read from stdin, stored
encrypted by Cloudflare, and is never written to `wrangler.toml`, to this repo,
or to your shell history. It is readable only as `env.GITHUB_TOKEN` inside the
Worker at runtime, and cannot be read back out of the dashboard.

If the secret is missing, the Worker throws immediately and dispatches nothing,
so the failure shows up as a failed cron invocation rather than a silent no-op.

## Verifying

Read-only status page — safe, triggers nothing, and confirms the secret is set:

```sh
curl https://github-actions-scheduler.<your-subdomain>.workers.dev/
```

Watch a real scheduled run as it happens:

```sh
npx wrangler tail --format pretty
```

Logs are also retained in the dashboard under **Workers & Pages ->
github-actions-scheduler -> Logs**, since `[observability]` is enabled.

Every run emits one JSON line per workflow with the GitHub response status:

```json
{"event":"batch_start","cron":"30 6,10 * * *","scheduledIst":"2026-09-09 12:00 IST","workflows":18}
{"event":"dispatch","workflow":"level1&2.yml","ok":true,"status":204,"attempts":1}
{"event":"batch_complete","cron":"30 6,10 * * *","triggered":18,"failed":0,"durationMs":2411}
```

A successful `workflow_dispatch` is **HTTP 204** with no body. Common failures:

| Status | Meaning |
| ------ | ------- |
| 401 | Token invalid or expired |
| 403 | Token lacks Actions write access to the repo (a bare 403 is not retried) |
| 404 | Workflow file name wrong, or the token cannot see the repo |
| 422 | `main` is not a valid ref, or the workflow has no `workflow_dispatch:` trigger |

Transient failures (5xx, 429, rate-limited 403) are retried up to 3 times with
backoff. If any workflow still fails, the run throws so it is flagged as a
failed invocation in the dashboard.

## Local testing

```sh
npm test                       # 16 tests, no network access, no real dispatches
npx wrangler dev --test-scheduled
```

> `wrangler dev --test-scheduled` exposes a `/__scheduled?cron=...` endpoint that
> performs **real** dispatches against the live repo if a token is present in
> `.dev.vars`. Use `npm test` for routine checks.

The test suite also guards the wiring: it fails if a workflow file is renamed or
added without updating this Worker, if a workflow regains a `schedule:` trigger
or loses `workflow_dispatch:`, or if the crons in `wrangler.toml` drift from the
routing keys in `src/index.js`.

## Changing the schedule

Cron expressions live in two places that must agree — `[triggers] crons` in
`wrangler.toml`, and the `MAIN_BATCH_CRON` / `LEVEL5_BATCH_CRON` constants in
`src/index.js` that key the workflow lists. `npm test` fails if they diverge.
Run `npx wrangler deploy` after any change.

## Security notes

- The token is a Cloudflare secret. It is not in this repo and not in
  `wrangler.toml`.
- Nothing is logged except workflow names, HTTP statuses, and truncated GitHub
  error bodies. A test asserts the token never appears in log output.
- The Worker exposes **no** HTTP route that triggers a workflow. The `fetch`
  handler returns read-only status; dispatching happens only from the cron
  handler. That way the public `workers.dev` URL cannot be used to start CI runs.
