// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/ci/tests/test-cache-base-protection`
 * Purpose: Exercise TEST protection admission and actual workflow cache ordering.
 * Scope: Pure facts, fake HTTP/clock and parsed committed workflows. Does not contact GitHub or write caches.
 * Invariants: FAIL_CLOSED, ALL_WRITERS_AFTER_GUARD, NO_NEW_JOB_DEPENDENCIES.
 * Side-effects: IO (read committed workflow files).
 * Links: https://cognidao.org/work/items/task.5315
 * @internal
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

import {
  assertContext,
  BRANCH,
  ENDPOINT,
  protectionState,
  readBranch,
  REPOSITORY,
  waitForProtection,
} from "../assert-test-cache-base-protection.mjs";

const sha = "1".repeat(40);
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: `refs/heads/${BRANCH}`,
  GITHUB_SHA: sha,
};
const contexts = ["unit", "component", "static", "manifest"];
const good = () => ({
  name: BRANCH,
  commit: { sha },
  protected: true,
  protection: {
    enabled: true,
    required_status_checks: {
      enforcement_level: "everyone",
      contexts: [...contexts],
      checks: contexts.map((context) => ({ context, app_id: 15368 })),
    },
  },
});

test("only exact real TEST push and checkout source are admitted", () => {
  assertContext(env, sha);
  for (const [key, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_REPOSITORY", "cogni-dao/node-template"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_REF", "refs/heads/main"],
    ["GITHUB_SHA", "bad"],
  ]) {
    assert.throws(() => assertContext({ ...env, [key]: value }, sha));
  }
  assert.throws(() => assertContext(env, "2".repeat(40)));
});

test("unknown, incomplete, foreign and unbound protection never passes", () => {
  assert.equal(protectionState(good(), sha), "protected");
  assert.equal(
    protectionState({ ...good(), protected: false }, sha),
    "waiting"
  );
  for (const change of [
    (x) => delete x.protected,
    (x) => (x.commit.sha = "2".repeat(40)),
    (x) => (x.name = "foreign"),
    (x) => delete x.protection,
    (x) => (x.protection.enabled = false),
    (x) => (x.protection.required_status_checks.enforcement_level = "off"),
    (x) => delete x.protection.required_status_checks.checks,
    (x) => (x.protection.required_status_checks.checks[0].app_id = null),
    (x) => x.protection.required_status_checks.contexts.pop(),
    (x) =>
      x.protection.required_status_checks.checks.push({
        context: "extra",
        app_id: 15368,
      }),
  ]) {
    const value = good();
    change(value);
    assert.throws(() => protectionState(value, sha));
  }
});

test("HTTP is fixed-origin read-only, bounded and never exposes a body/token", async () => {
  let requests = 0;
  const value = await readBranch(
    "fake-test-only-token",
    1_000,
    async (url, options) => {
      requests++;
      assert.equal(url, ENDPOINT);
      assert.equal(options.method, undefined); // Fetch's GET default; never a policy mutation.
      assert.equal(options.redirect, "error");
      assert.equal(
        options.headers.Authorization,
        "Bearer fake-test-only-token"
      );
      return new Response(JSON.stringify(good()), { status: 200 });
    }
  );
  assert.equal(requests, 1);
  assert.deepEqual(value, good());
  for (const status of [403, 404, 502]) {
    await assert.rejects(() =>
      readBranch(
        "fake",
        1_000,
        async () => new Response("private body", { status })
      )
    );
  }
  await assert.rejects(() =>
    readBranch("fake", 1_000, async () => new Response("x".repeat(65_537)))
  );
  await assert.rejects(() =>
    readBranch("fake", 1_000, async () => new Response("invalid JSON"))
  );
});

test("known unprotected state can transition; errors and deadline fail immediately", async () => {
  let clock = 0;
  let reads = 0;
  const records = [];
  const setup = {
    env,
    checkoutSha: sha,
    token: "fake",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (record) => records.push(record),
  };
  await waitForProtection({
    ...setup,
    read: async () =>
      ++reads === 1 ? { ...good(), protected: false } : good(),
  });
  assert.deepEqual(
    records.map((x) => x.state),
    ["waiting", "protected"]
  );
  assert.equal(JSON.stringify(records).includes("fake"), false);
  reads = 0;
  await assert.rejects(() =>
    waitForProtection({
      ...setup,
      read: async () => {
        reads++;
        throw new Error("HTTP unavailable");
      },
    })
  );
  assert.equal(reads, 1);
  await assert.rejects(
    () =>
      waitForProtection({
        ...setup,
        read: async () => ({ ...good(), protected: false }),
      }),
    /deadline/
  );
  await assert.rejects(() =>
    waitForProtection({ ...setup, token: "", read: async () => good() })
  );
});

const ci = parse(
  readFileSync(
    new URL("../../../.github/workflows/ci.yaml", import.meta.url),
    "utf8"
  )
);
const build = parse(
  readFileSync(
    new URL("../../../.github/workflows/pr-build.yml", import.meta.url),
    "utf8"
  )
);
const fixtureCondition = `github.repository == '${REPOSITORY}' && github.event_name == 'push' && github.ref == 'refs/heads/${BRANCH}'`;

function verifyOrdering(workflow, jobs) {
  for (const name of jobs) {
    const steps = workflow.jobs[name].steps;
    const gates = steps
      .map((x, i) => [x, i])
      .filter(
        ([x]) =>
          x.run === "node scripts/ci/assert-test-cache-base-protection.mjs"
      );
    assert.equal(gates.length, 1, `${name}: one guard`);
    const [gate, index] = gates[0];
    assert.equal(gate.if, fixtureCondition);
    assert.equal(gate.env.GH_TOKEN, "${{ github.token }}");
    assert.equal(
      index,
      1,
      `${name}: checkout then guard before any setup/cache action`
    );
    assert.match(steps[0].uses, /^actions\/checkout@/);
    assert.ok(
      !steps
        .slice(0, index)
        .some((x) => x.uses && !x.uses.startsWith("actions/checkout@"))
    );
  }
}

test("actual workflow guards precede ALL setup/cache actions without new needs", () => {
  assert.deepEqual(Object.keys(ci.jobs).sort(), [
    "component",
    "static",
    "unit",
  ]);
  for (const job of Object.values(ci.jobs)) assert.equal(job.needs, undefined);
  verifyOrdering(ci, ["static", "unit", "component"]);
  verifyOrdering(build, ["resolve"]);
  assert.deepEqual(build.jobs.detect.needs, "resolve");
  assert.deepEqual(build.jobs.build.needs, ["resolve", "detect"]);
  assert.deepEqual(build.jobs.manifest.needs, ["resolve", "detect", "build"]);
  assert.equal(build.jobs.manifest.if, "always()");
  const broken = structuredClone(ci);
  [broken.jobs.unit.steps[1], broken.jobs.unit.steps[2]] = [
    broken.jobs.unit.steps[2],
    broken.jobs.unit.steps[1],
  ];
  assert.throws(() => verifyOrdering(broken, ["unit"]));
});

test("actual TEST seed condition excludes PR, main, dispatch and foreign repos", () => {
  const check = (github) => runInNewContext(fixtureCondition, { github });
  const github = {
    repository: REPOSITORY,
    event_name: "push",
    ref: `refs/heads/${BRANCH}`,
  };
  assert.equal(check(github), true);
  for (const change of [
    { repository: "cogni-dao/node-template" },
    { event_name: "pull_request" },
    { event_name: "workflow_dispatch" },
    { ref: "refs/heads/main" },
    { ref: "refs/heads/test/foreign" },
  ])
    assert.equal(check({ ...github, ...change }), false);
  assert.deepEqual(ci.on.push.branches, ["main", BRANCH]);
  assert.deepEqual(build.on.push.branches, ["main", BRANCH]);
});

test("actual cache export expression writes only main or exact real TEST seed push", () => {
  const step = build.jobs.build.steps.find((step) =>
    step.uses?.startsWith("docker/build-push-action@")
  );
  const expression = step.with["cache-to"]
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");
  const github = {
    repository: REPOSITORY,
    event_name: "push",
    ref: `refs/heads/${BRANCH}`,
  };
  const evaluate = (value) =>
    runInNewContext(expression, {
      github: value,
      matrix: { target: { artifact: "app" } },
      format: (template, argument) => template.replace("{0}", argument),
    });
  assert.equal(evaluate(github), "type=gha,mode=max,scope=node-template-app");
  assert.equal(
    evaluate({ ...github, ref: "refs/heads/main" }),
    "type=gha,mode=max,scope=node-template-app"
  );
  for (const change of [
    { event_name: "pull_request" },
    { event_name: "workflow_dispatch" },
    { repository: "cogni-dao/node-template" },
    { ref: "refs/heads/test/foreign" },
  ])
    assert.equal(evaluate({ ...github, ...change }), "");
});
