import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const MAIN_CRON = "30 6,10 * * *";
const LEVEL5_CRON = "30 7,11 * * *";

const TOKEN = "ghp_ThisIsAFakeTokenForTests000000000000";

const ENV = {
  GITHUB_TOKEN: TOKEN,
  GITHUB_OWNER: "gfiuser09",
  GITHUB_REPO: "Jobs-scraping-tool",
  GITHUB_REF: "main",
};

/**
 * Runs the scheduled handler with fetch and console.log stubbed out, and
 * returns everything the handler tried to do.
 */
async function runScheduled({ cron, env = ENV, respond }) {
  const calls = [];
  const logs = [];

  const realFetch = globalThis.fetch;
  const realLog = console.log;

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond
      ? respond(calls.length, url)
      : new Response(null, { status: 204 });
  };
  console.log = (line) => logs.push(line);

  let thrown = null;
  try {
    await worker.scheduled(
      { cron, scheduledTime: Date.UTC(2026, 8, 9, 6, 30) },
      env,
    );
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }

  return { calls, logs, thrown };
}

const eventsIn = (logs) => logs.map((line) => JSON.parse(line));

test("main batch dispatches the 18 non-level-5 workflows", async () => {
  const { calls, thrown } = await runScheduled({ cron: MAIN_CRON });

  assert.equal(thrown, null);
  assert.equal(calls.length, 18);

  const dispatched = calls.map((call) =>
    decodeURIComponent(call.url.split("/actions/workflows/")[1].replace("/dispatches", "")),
  );
  assert.ok(!dispatched.includes("level5.yml"));
  assert.ok(!dispatched.includes("level5_sustain.yml"));
  assert.equal(new Set(dispatched).size, 18, "no workflow dispatched twice");
});

test("level 5 batch dispatches only the two level 5 workflows", async () => {
  const { calls, thrown } = await runScheduled({ cron: LEVEL5_CRON });

  assert.equal(thrown, null);
  assert.equal(calls.length, 2);

  const dispatched = calls.map((call) =>
    call.url.split("/actions/workflows/")[1].replace("/dispatches", ""),
  );
  assert.deepEqual(dispatched.sort(), ["level5.yml", "level5_sustain.yml"]);
});

test("the & in level1&2.yml is percent-encoded in the request path", async () => {
  const { calls } = await runScheduled({ cron: MAIN_CRON });

  const url = calls.map((c) => c.url).find((u) => u.includes("level1"));
  assert.ok(
    url.includes("/actions/workflows/level1%262.yml/dispatches"),
    `expected an encoded path, got ${url}`,
  );
});

test("each request targets the configured repo and ref with auth headers", async () => {
  const { calls } = await runScheduled({ cron: LEVEL5_CRON });
  const { url, init } = calls[0];

  assert.ok(
    url.startsWith(
      "https://api.github.com/repos/gfiuser09/Jobs-scraping-tool/actions/workflows/",
    ),
    url,
  );
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { ref: "main" });
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, "application/vnd.github+json");
  assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(init.headers["User-Agent"]);
});

test("every dispatch logs its GitHub response status", async () => {
  const { logs } = await runScheduled({ cron: MAIN_CRON });

  const dispatches = eventsIn(logs).filter((e) => e.event === "dispatch");
  assert.equal(dispatches.length, 18);
  assert.ok(dispatches.every((d) => d.status === 204 && d.ok === true));

  const complete = eventsIn(logs).find((e) => e.event === "batch_complete");
  assert.equal(complete.triggered, 18);
  assert.equal(complete.failed, 0);
});

test("the token never appears in any log line", async () => {
  const { logs } = await runScheduled({
    cron: LEVEL5_CRON,
    // Force an error path too, since that is where a body gets logged.
    respond: () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  });

  assert.ok(logs.length > 0);
  assert.ok(
    logs.every((line) => !line.includes(TOKEN)),
    "a log line contained the GitHub token",
  );
});

test("a transient 500 is retried and then succeeds", async () => {
  const { calls, logs, thrown } = await runScheduled({
    cron: LEVEL5_CRON,
    respond: (n) =>
      n === 1
        ? new Response("upstream boom", { status: 500 })
        : new Response(null, { status: 204 }),
  });

  assert.equal(thrown, null);
  assert.equal(calls.length, 3, "two workflows, one of them retried once");

  const retried = eventsIn(logs).find(
    (e) => e.event === "dispatch" && e.attempts === 2,
  );
  assert.ok(retried, "expected one dispatch to report a second attempt");
  assert.equal(retried.ok, true);
});

test("a 404 is not retried and fails the run with a diagnosable message", async () => {
  const { calls, logs, thrown } = await runScheduled({
    cron: LEVEL5_CRON,
    respond: () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  });

  assert.equal(calls.length, 2, "404 must not be retried");
  assert.ok(thrown, "the run should fail so the failure is visible");
  assert.match(thrown.message, /2 of 2 dispatches failed/);
  assert.match(thrown.message, /HTTP 404/);

  const dispatches = eventsIn(logs).filter((e) => e.event === "dispatch");
  assert.ok(dispatches.every((d) => d.status === 404 && d.ok === false));
  assert.match(dispatches[0].detail, /Not Found/);
});

test("a bare 403 is treated as a permissions failure, not a rate limit", async () => {
  const { calls } = await runScheduled({
    cron: LEVEL5_CRON,
    respond: () =>
      new Response(JSON.stringify({ message: "Resource not accessible" }), {
        status: 403,
      }),
  });

  assert.equal(calls.length, 2, "a bare 403 must not be retried");
});

test("a rate-limited 403 is retried", async () => {
  const { calls } = await runScheduled({
    cron: LEVEL5_CRON,
    respond: (n) =>
      n <= 2
        ? new Response("slow down", {
            status: 403,
            headers: { "retry-after": "1", "x-ratelimit-remaining": "0" },
          })
        : new Response(null, { status: 204 }),
  });

  assert.ok(calls.length > 2, "expected retries after a rate-limited 403");
});

test("an unrecognised cron dispatches nothing", async () => {
  const { calls, logs, thrown } = await runScheduled({ cron: "0 0 * * *" });

  assert.equal(calls.length, 0);
  assert.equal(thrown, null);
  assert.equal(eventsIn(logs)[0].event, "unknown_cron");
});

test("a missing token fails before any request is sent", async () => {
  const { calls, thrown } = await runScheduled({
    cron: MAIN_CRON,
    env: { ...ENV, GITHUB_TOKEN: "" },
  });

  assert.equal(calls.length, 0);
  assert.match(thrown.message, /GITHUB_TOKEN is not set/);
});

test("the status endpoint reports config without revealing the token", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), ENV);
  const body = await response.json();

  assert.equal(body.repo, "gfiuser09/Jobs-scraping-tool");
  assert.equal(body.tokenConfigured, true);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test("every scheduled workflow name matches a real file in .github/workflows", async () => {
  const { readdirSync } = await import("node:fs");

  const onDisk = new Set(
    readdirSync(new URL("../../.github/workflows", import.meta.url)).filter(
      (file) => file.endsWith(".yml") || file.endsWith(".yaml"),
    ),
  );

  const { calls: mainCalls } = await runScheduled({ cron: MAIN_CRON });
  const { calls: level5Calls } = await runScheduled({ cron: LEVEL5_CRON });

  const scheduled = [...mainCalls, ...level5Calls].map((call) =>
    decodeURIComponent(
      call.url.split("/actions/workflows/")[1].replace("/dispatches", ""),
    ),
  );

  const missing = scheduled.filter((file) => !onDisk.has(file));
  assert.deepEqual(missing, [], "scheduled workflows with no file on disk");

  const unscheduled = [...onDisk].filter((file) => !scheduled.includes(file));
  assert.deepEqual(unscheduled, [], "workflow files no schedule triggers");
});

test("no workflow still carries its own schedule: trigger", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../.github/workflows/", import.meta.url);

  const offenders = readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .filter((file) => {
      const text = readFileSync(new URL(file, dir), "utf8");
      // Strip comments first: the replacement comment mentions "schedule:".
      const withoutComments = text.replace(/^\s*#.*$/gm, "");
      return (
        /^\s*schedule:/m.test(withoutComments) ||
        !/^\s*workflow_dispatch:/m.test(withoutComments)
      );
    });

  assert.deepEqual(offenders, [], "workflows with schedule: or no dispatch");
});

test("the cron keys in the code match the ones in wrangler.toml", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

  // Match quoted entries rather than splitting on commas - the cron
  // expressions contain commas of their own ("30 6,10 * * *").
  const configured = [
    ...toml.match(/^crons\s*=\s*\[(.*)\]/m)[1].matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);

  // Rebuild the two batch keys the same way a trigger would arrive.
  assert.deepEqual(configured.sort(), [MAIN_CRON, LEVEL5_CRON].sort());
});
