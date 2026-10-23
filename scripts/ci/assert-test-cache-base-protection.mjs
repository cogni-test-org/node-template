// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/ci/assert-test-cache-base-protection`
 * Purpose: Admit the one reviewed TEST seed's cache writers after protection applies.
 * Scope: Fixed TEST repository/ref and public branch facts. Does not change policy or attest an external admin readback.
 * Invariants: TEST_ONLY, EXACT_SOURCE, FOUR_APP_BOUND_CHECKS, BEFORE_CACHE_ACTIONS.
 * Side-effects: IO (bounded contents-read GitHub requests and public status output).
 * Links: https://cognidao.org/work/items/task.5315
 * @internal
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "cogni-test-org/node-template";
export const BRANCH = "test/task5315-trusted-cache-current-821dc";
export const ENDPOINT = `https://api.github.com/repos/${REPOSITORY}/branches/${encodeURIComponent(BRANCH)}`;
const CONTEXTS = ["component", "manifest", "static", "unit"];

export function assertContext(env, checkoutSha) {
  assert.equal(env.GITHUB_ACTIONS, "true", "GitHub Actions required");
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "wrong TEST repository");
  assert.equal(env.GITHUB_EVENT_NAME, "push", "real push required");
  assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`, "wrong TEST ref");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/, "invalid source SHA");
  assert.equal(checkoutSha, env.GITHUB_SHA, "checkout/source drift");
}

export function protectionState(branch, sha) {
  assert.equal(branch.name, BRANCH, "branch name drift");
  assert.equal(branch.commit?.sha, sha, "branch source drift");
  // Only this known initial state can wait. Missing/unknown policy is not green.
  if (branch.protected === false) return "waiting";
  assert.equal(branch.protected, true, "unknown protection state");
  assert.equal(branch.protection?.enabled, true, "protection disabled");
  const required = branch.protection.required_status_checks;
  assert.equal(required?.enforcement_level, "everyone", "checks not enforced");
  assert.ok(Array.isArray(required.contexts), "missing contexts");
  assert.deepEqual([...required.contexts].sort(), CONTEXTS, "context mismatch");
  assert.ok(Array.isArray(required.checks), "missing app-bound checks");
  assert.equal(required.checks.length, 4, "unexpected check count");
  assert.deepEqual(
    required.checks.map((check) => check.context).sort(),
    CONTEXTS,
    "check membership mismatch"
  );
  assert.ok(
    required.checks.every((check) => check.app_id === 15368),
    "required check App mismatch"
  );
  return "protected";
}

export async function readBranch(token, remaining, fetcher = fetch) {
  const response = await fetcher(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
  });
  assert.equal(response.status, 200, "branch API unavailable");
  // Bound the body while reading, including chunked responses.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      assert.ok(size <= 65_536, "branch response too large");
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function waitForProtection({
  env,
  checkoutSha,
  token,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  read = readBranch,
  log = (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
}) {
  assertContext(env, checkoutSha);
  assert.ok(token, "contents-read GitHub token required");
  const started = now();
  const deadline = started + 120_000;
  for (let attempt = 1; ; attempt++) {
    assert.ok(now() < deadline, "protection wait deadline");
    const branch = await read(token, deadline - now());
    assert.ok(now() < deadline, "protection wait deadline");
    const state = protectionState(branch, checkoutSha);
    log({
      fixture: BRANCH,
      sourceSha: checkoutSha,
      state,
      attempt,
      elapsedMs: now() - started,
    });
    if (state === "protected") return;
    await sleep(Math.min(5_000, Math.max(0, deadline - now())));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assert.equal(process.argv.length, 2, "no policy overrides allowed");
    await waitForProtection({
      env: process.env,
      checkoutSha: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      token: process.env.GH_TOKEN,
    });
  } catch {
    // Do not serialize fetch exceptions, tokens, response bodies or ambient env.
    process.stderr.write("TEST cache-base protection guard failed\n");
    process.exitCode = 1;
  }
}
