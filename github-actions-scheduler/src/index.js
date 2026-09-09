/**
 * Triggers the GitHub Actions workflows in gfiuser09/Jobs-scraping-tool on a
 * fixed IST schedule, replacing the `schedule:` triggers that used to live in
 * each workflow file.
 *
 * GitHub's own cron scheduler queues runs against shared capacity and routinely
 * fires late; driving the same dispatches from a Cloudflare Cron Trigger keeps
 * the start times predictable.
 *
 * The cron strings below are the exact values from wrangler.toml - they are the
 * routing keys, so a change there has to be mirrored here or the batch will not
 * be found at runtime.
 */

/** 12:00 and 16:00 IST (06:30 and 10:30 UTC). */
const MAIN_BATCH_CRON = "30 6,10 * * *";

/** 13:00 and 17:00 IST (07:30 and 11:30 UTC) - an hour behind the main batch. */
const LEVEL5_BATCH_CRON = "30 7,11 * * *";

/**
 * Which workflow files each Cron Trigger dispatches. Names must match the file
 * names in .github/workflows exactly; the API addresses a workflow by file name.
 */
const WORKFLOWS = {
  [MAIN_BATCH_CRON]: [
    "level1&2.yml",
    "level3.yml",
    "darwinbox.yml",
    "freshteam.yml",
    "keka.yml",
    "lever.yml",
    "smart.yml",
    "workable.yml",
    "zoho.yml",
    "sustain-darwinbox.yml",
    "sustain-eightfold.yml",
    "sustain-keka.yml",
    "sustain-smart.yml",
    "sustain-workable.yml",
    "sustain-workday.yml",
    "sustain-zoho.yml",
    "sustain_oracle_cloude.yml",
    "sustain_oracle_hcm.yml",
  ],
  [LEVEL5_BATCH_CRON]: ["level5.yml", "level5_sustain.yml"],
};

const GITHUB_API = "https://api.github.com";

/** Attempts per workflow, including the first. */
const MAX_ATTEMPTS = 3;

/**
 * Workflows dispatched at once. GitHub applies a secondary rate limit to bursts
 * of writes, and a batch of 18 sent in parallel sits close enough to it to be
 * worth spreading out - the whole batch still finishes in a few seconds.
 */
const CONCURRENCY = 5;

export default {
  /**
   * @param {ScheduledController} event
   * @param {{ GITHUB_TOKEN: string, GITHUB_OWNER: string, GITHUB_REPO: string, GITHUB_REF: string }} env
   */
  async scheduled(event, env) {
    const workflows = WORKFLOWS[event.cron];

    if (!workflows) {
      // A Cron Trigger exists that this file has no batch for - most likely a
      // cron edited in wrangler.toml or the dashboard without updating the keys
      // above. Log it rather than dispatching an arbitrary batch.
      log("unknown_cron", {
        cron: event.cron,
        knownCrons: Object.keys(WORKFLOWS),
      });
      return;
    }

    if (!env.GITHUB_TOKEN) {
      // Thrown, not logged and swallowed, so the run is marked failed in the
      // dashboard. The message names the secret but never reads its value.
      throw new Error(
        "GITHUB_TOKEN is not set. Run: wrangler secret put GITHUB_TOKEN",
      );
    }

    const startedAt = Date.now();
    log("batch_start", {
      cron: event.cron,
      scheduledUtc: new Date(event.scheduledTime).toISOString(),
      scheduledIst: toIst(event.scheduledTime),
      repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
      ref: env.GITHUB_REF,
      workflows: workflows.length,
    });

    const results = await dispatchAll(workflows, env);

    for (const result of results) {
      log("dispatch", result);
    }

    const failures = results.filter((result) => !result.ok);
    log("batch_complete", {
      cron: event.cron,
      triggered: results.length - failures.length,
      failed: failures.length,
      durationMs: Date.now() - startedAt,
    });

    if (failures.length > 0) {
      // Marks the invocation as failed so a bad night is visible on the Worker's
      // dashboard without having to read through the logs.
      throw new Error(
        `${failures.length} of ${results.length} dispatches failed: ` +
          failures.map((f) => `${f.workflow} (HTTP ${f.status})`).join(", "),
      );
    }
  },

  /**
   * Read-only status endpoint. This Worker holds a token that can start CI runs,
   * so it deliberately exposes no HTTP route that dispatches anything - the only
   * caller is the Cron Trigger. To exercise the schedule locally, use
   * `wrangler dev --test-scheduled` and hit /__scheduled?cron=<expression>.
   */
  async fetch(request, env) {
    return Response.json({
      worker: "github-actions-scheduler",
      repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`,
      ref: env.GITHUB_REF,
      tokenConfigured: Boolean(env.GITHUB_TOKEN),
      schedule: {
        [MAIN_BATCH_CRON]: {
          ist: ["12:00", "16:00"],
          workflows: WORKFLOWS[MAIN_BATCH_CRON],
        },
        [LEVEL5_BATCH_CRON]: {
          ist: ["13:00", "17:00"],
          workflows: WORKFLOWS[LEVEL5_BATCH_CRON],
        },
      },
    });
  },
};

/**
 * Dispatches every workflow in the batch, a few at a time, and collects one
 * result per workflow. Never rejects: a single bad workflow must not stop the
 * rest of the batch from being triggered.
 */
async function dispatchAll(workflowFiles, env) {
  const results = [];

  for (let i = 0; i < workflowFiles.length; i += CONCURRENCY) {
    const slice = workflowFiles.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      slice.map((file) => dispatchWorkflow(file, env)),
    );
    results.push(...settled);
  }

  return results;
}

/**
 * POSTs a workflow_dispatch for one workflow file, retrying transient failures.
 * Resolves with the outcome rather than throwing, so the caller can report on
 * every workflow in the batch.
 */
async function dispatchWorkflow(workflowFile, env) {
  // level1&2.yml contains an "&". Encoding the file name keeps that from being
  // read as anything other than part of the path segment.
  const url =
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
    `/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          // GitHub rejects API requests that do not identify a caller.
          "User-Agent": "github-actions-scheduler (Cloudflare Worker)",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: env.GITHUB_REF }),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return {
        workflow: workflowFile,
        ok: false,
        status: 0,
        attempts: attempt,
        detail: `network error: ${error.message}`,
      };
    }

    // A successful dispatch is 204 No Content - there is no body and no run id.
    if (response.status === 204) {
      return {
        workflow: workflowFile,
        ok: true,
        status: 204,
        attempts: attempt,
      };
    }

    const detail = await readErrorBody(response);

    if (attempt < MAX_ATTEMPTS && isRetryable(response)) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }

    return {
      workflow: workflowFile,
      ok: false,
      status: response.status,
      attempts: attempt,
      detail,
    };
  }
}

/**
 * Transient conditions worth a second attempt. A plain 403 is not one of them:
 * for this endpoint it means the token lacks Actions write access or cannot see
 * the repo, and retrying will fail identically.
 */
function isRetryable(response) {
  if (response.status >= 500) return true;
  if (response.status === 429) return true;

  if (response.status === 403) {
    // GitHub returns 403 for both "forbidden" and "secondary rate limit". Only
    // the rate-limited variant carries these hints.
    return (
      response.headers.has("retry-after") ||
      response.headers.get("x-ratelimit-remaining") === "0"
    );
  }

  return false;
}

/** Honours GitHub's Retry-After when present, capped so a batch cannot stall. */
function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 30_000);
  }

  return backoffMs(attempt);
}

/** 1s, then 2s. */
function backoffMs(attempt) {
  return 1000 * 2 ** (attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GitHub error bodies are small JSON objects such as {"message": "Not Found"}.
 * They never contain the request's credentials, but the text is truncated
 * anyway so an unexpected HTML error page cannot flood the logs.
 */
async function readErrorBody(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<unreadable response body>";
  }
}

/** IST is a fixed UTC+5:30 offset, so a plain shift is exact. */
function toIst(epochMs) {
  const shifted = new Date(epochMs + (5 * 60 + 30) * 60 * 1000);
  return `${shifted.toISOString().slice(0, 16).replace("T", " ")} IST`;
}

/** One JSON object per line, so the log stream can be filtered and parsed. */
function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
