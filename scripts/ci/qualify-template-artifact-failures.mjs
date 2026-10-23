// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@scripts/ci/qualify-template-artifact-failures`
 * Purpose: Exercise actual resolver and missing-artifact consumers in a TEST fixture.
 * Scope: Fixed TEST PR metadata and owned temporary files. Does not dispatch, publish, or change source.
 * Invariants: REAL_CONSUMER_REJECTION, NO_OUTPUT_BEFORE_VALID_BUNDLE, TEST_ONLY.
 * Side-effects: IO (read source, bounded local subprocesses and owned temporary files).
 * Links: https://cognidao.org/work/items/task.5315
 * @internal
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const REPOSITORY = "cogni-test-org/node-template";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "878acc9a5837c51e0df81c28403ae885f9903438";

export function qualifyResolverBoundary(workflow, owned) {
  const command = workflow.jobs.resolve.steps.find(
    (step) => step.name === "Resolve source metadata"
  ).run;
  const metadata = {
    EVENT_NAME: "pull_request", PUSH_SHA: "1".repeat(40),
    PR_HEAD_SHA: "2".repeat(40), PR_HEAD_REF: "test/owned-resolver",
    PR_HEAD_REPO: REPOSITORY, REPOSITORY, REPOSITORY_OWNER: "cogni-test-org",
    MQ_HEAD_REF: "refs/heads/test/owned-queue", REF_NAME: "main",
    DISPATCH_HEAD_REPO: "", DISPATCH_HEAD_SHA: "",
  };
  const cases = [
    { name: "same-repo-pr", values: {}, push: "true" },
    { name: "foreign-pr", values: { PR_HEAD_REPO: "foreign-fixture/node-template" }, push: "false" },
    { name: "push", values: { EVENT_NAME: "push" }, push: "true" },
    { name: "queue", values: { EVENT_NAME: "merge_group" }, push: "true" },
    { name: "trusted-dispatch-metadata-only", values: { EVENT_NAME: "workflow_dispatch", DISPATCH_HEAD_REPO: "foreign-fixture/node-template", DISPATCH_HEAD_SHA: "3".repeat(40) }, push: "true" },
    { name: "malformed-dispatch-sha", values: { EVENT_NAME: "workflow_dispatch", DISPATCH_HEAD_REPO: REPOSITORY, DISPATCH_HEAD_SHA: "not-a-sha" }, error: "head_sha must be a 40-char hex SHA" },
    { name: "malformed-dispatch-repo", values: { EVENT_NAME: "workflow_dispatch", DISPATCH_HEAD_REPO: "foreign;invalid/repo", DISPATCH_HEAD_SHA: "3".repeat(40) }, error: "head_repo must be owner/name" },
    { name: "unsupported-event", values: { EVENT_NAME: "issue_comment" }, error: "Unsupported event" },
  ];
  for (const item of cases) {
    const output = join(owned, item.name + ".output");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", command], {
      cwd: ROOT, env: { ...process.env, ...metadata, ...item.values, GITHUB_OUTPUT: output },
      encoding: "utf8", timeout: 10_000, maxBuffer: 32_768,
    });
    assert(!result.error && result.status !== null);
    if (item.error) {
      assert.notEqual(result.status, 0);
      assert((result.stdout + result.stderr).includes(item.error));
      assert(!existsSync(output));
    } else {
      assert.equal(result.status, 0);
      const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      assert.equal(values.should_push, item.push);
      assert.equal(values.checkout_repo, item.name === "trusted-dispatch-metadata-only" ? "foreign-fixture/node-template" : REPOSITORY);
      assert.equal(values.source_sha, item.name === "trusted-dispatch-metadata-only" ? "3".repeat(40) : ["push", "queue"].includes(item.name) ? metadata.PUSH_SHA : metadata.PR_HEAD_SHA);
    }
  }
  const build = workflow.jobs.build.steps.find((step) => step.name === "Build app image");
  assert.equal(build.with.push, "${{ needs.resolve.outputs.should_push == 'true' }}");
  for (const [job, name] of [["build", "Login to GHCR"], ["manifest", "Set up ORAS"], ["manifest", "Login to GHCR for bundle publication"], ["manifest", "Publish immutable node artifact bundle"]]) {
    assert.equal(workflow.jobs[job].steps.find((step) => step.name === name).if, "needs.resolve.outputs.should_push == 'true'");
  }
  assert.equal(workflow.jobs.manifest.steps.find((step) => step.name === "Write build manifest").env.EMIT_BUNDLE, "${{ needs.resolve.outputs.should_push }}");
  return cases.map((item) => item.name);
}

function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_EVENT_NAME, "pull_request");
  assert.equal(process.env.GITHUB_BASE_REF, "test/task5315-current-3ab-baseline");
  assert.equal(process.env.GITHUB_HEAD_REF, "test/task5315-current-3ab-negative-digest");
  assert.equal(process.cwd(), ROOT);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(event.pull_request.head.repo.full_name, REPOSITORY);
  assert.equal(event.pull_request.base.repo.full_name, REPOSITORY);
  assert.equal(event.pull_request.base.sha, BASE);
  assert.equal(event.pull_request.head.sha, process.env.SOURCE_SHA);
  assert.match(process.env.SOURCE_SHA, /^[a-f0-9]{40}$/);
  assert.equal(process.env.EMIT_BUNDLE, "true");
  for (const key of ["IMAGE_NAME", "IMAGE_TAG", "SOURCE_REPOSITORY", "REPOSITORY", "FRAGMENTS_DIR"]) assert(process.env[key]);
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/pr-build.yml"), "utf8"));
  const fragmentStep = workflow.jobs.build.steps.find((step) => step.name === "Write build fragment");
  assert.equal(fragmentStep.run, "node scripts/ci/write-node-build-fragment.mjs");
  assert.equal(fragmentStep.env.DIGEST, "");
  const owned = mkdtempSync(join(process.env.RUNNER_TEMP, "artifact-negative-"));
  try {
    const resolverCases = qualifyResolverBoundary(workflow, owned);
    const manifest = join(owned, "empty-manifest.json");
    const bundle = join(owned, "empty-bundle.json");
    const empty = join(owned, "empty-fragments");
    mkdirSync(empty);
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/ci/write-node-build-manifest.mjs")], {
      cwd: ROOT,
      env: { ...process.env, FRAGMENTS_DIR: empty, MANIFEST_FILE: manifest, BUNDLE_FILE: bundle },
      encoding: "utf8", timeout: 10_000, maxBuffer: 32_768,
    });
    assert(!result.error && result.status !== null);
    assert.notEqual(result.status, 0);
    assert((result.stdout + result.stderr).includes("[artifact-bundle] Missing artifact for service app: app"));
    assert([manifest, bundle, manifest + ".tmp", bundle + ".tmp"].every((path) => !existsSync(path)));
    const fragments = readdirSync(process.env.FRAGMENTS_DIR).filter((name) => name.endsWith(".json"));
    assert.equal(fragments.length, 1);
    const payload = JSON.parse(readFileSync(join(process.env.FRAGMENTS_DIR, fragments[0]), "utf8"));
    assert.equal(payload.built_artifact, undefined);
    assert.equal(payload.targets.length, 1);
    assert.equal(payload.targets[0].digest, "");
    assert.equal(payload.targets[0].sourceSha, process.env.SOURCE_SHA);
    console.info(JSON.stringify({ qualificationOnly: true, sourceSha: process.env.SOURCE_SHA, resolverCases, emptyFragmentsRejectedBeforeOutputs: true, actualMissingDigestFragmentObserved: true }));
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch { console.error("TEST artifact failure qualification rejected; no consumer proof claimed"); process.exitCode = 1; }
}
