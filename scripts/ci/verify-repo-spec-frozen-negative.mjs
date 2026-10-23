// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/ci/verify-repo-spec-frozen-negative`
 * Purpose: Qualify the current TEST contract install against a real lock mismatch.
 * Scope: Exact declared workspace metadata and owned temporary files. Does not publish artifacts or change repository inputs.
 * Invariants: FROZEN_LOCK_REQUIRED, CURRENT_WORKSPACE_MEMBERSHIP, NO_SOURCE_MUTATION.
 * Side-effects: IO (public metadata, owned temporary files and bounded pnpm child).
 * Links: https://cognidao.org/work/items/task.5315
 * @internal
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Reviewed821dc metadata plus declared TEST YAML2.9.1; no fixture fallback.
const INPUTS = [
  {
    path: "app/package.json",
    blob: "4a887064cf51b4a29e89f7269e73445e0f80e7bf",
  },
  {
    path: "graphs/package.json",
    blob: "89318b9f8f53976e81f85adf36d8b2601a6adf26",
  },
  {
    path: "package.json",
    blob: "b9e6acaeea495309c662e3d16d45c5475be5f001",
  },
  {
    path: "packages/ai-core/package.json",
    blob: "5c573286b12ac060574b24fbfd0ee378f08d52a4",
  },
  {
    path: "packages/ai-tools/package.json",
    blob: "a8bac21a9a36de7e5b6be58373c067692038a355",
  },
  {
    path: "packages/aragon-osx/package.json",
    blob: "e4dc29c1a6f816613537337ed3b53ad9ecd2481e",
  },
  {
    path: "packages/attribution-collect/package.json",
    blob: "efd7cbd2a9533a5c1ac1f8319d2dc3a83bbed781",
  },
  {
    path: "packages/attribution-ledger/package.json",
    blob: "16cc39de00ad91a47c9320ba739ee068a7775ec3",
  },
  {
    path: "packages/attribution-pipeline-contracts/package.json",
    blob: "2d78b34fa4dec5173afa156bf7d7a2e01da2c8ca",
  },
  {
    path: "packages/attribution-pipeline-plugins/package.json",
    blob: "5da0238c04b9d29d6474cf2a2bd714057f720d81",
  },
  {
    path: "packages/cogni-contracts/package.json",
    blob: "69cebd45a142de8f68a3f14fef6a0906dd1c53f7",
  },
  {
    path: "packages/db-client/package.json",
    blob: "fc6fd4c3c957bfe2b6eb0172844f5cd383c26b2f",
  },
  {
    path: "packages/db-schema/package.json",
    blob: "fa16bc87ad8540c793c2475cf3caa44c7323de3b",
  },
  {
    path: "packages/doltgres-admission/package.json",
    blob: "1f74d1243e374cfd973da9e6dc6825c69cba5b06",
  },
  {
    path: "packages/doltgres-schema/package.json",
    blob: "eae4f8f97b5c3f791efd5d5fa401c6a40929e2bf",
  },
  {
    path: "packages/financial-ledger/package.json",
    blob: "313b384189a35a9cc07d4e5bd706d3b9ebe5f7b4",
  },
  {
    path: "packages/graph-execution-core/package.json",
    blob: "b76cf1fee483ec8311a3170461c2b18cafbbed64",
  },
  {
    path: "packages/graph-execution-host/package.json",
    blob: "aa38a5d66286a719529adf65b2b31b85b1a50c76",
  },
  {
    path: "packages/ids/package.json",
    blob: "a9411c5cac79295c02c8364527d61b171e4bfce4",
  },
  {
    path: "packages/ingestion-core/package.json",
    blob: "e0a456e61d7fd4c5033a63f051e12db542952330",
  },
  {
    path: "packages/knowledge-base-ui/package.json",
    blob: "6e3538eb49304533c15862a9281d15a6b7e0ff8c",
  },
  {
    path: "packages/knowledge-base/package.json",
    blob: "1f9c3752b4b050edea4f2d5c6fd84a0df3e2b519",
  },
  {
    path: "packages/knowledge-store/package.json",
    blob: "4ac85fb81d1c277d990b0965774e03d30a183627",
  },
  {
    path: "packages/langgraph-graphs/package.json",
    blob: "e71be97bb8bc5fd2a0f9dbc58145fb5b16f8aeda",
  },
  {
    path: "packages/node-app/package.json",
    blob: "7b8446b6cf87abf9e18b8bcf09b3d1e5bb6a217f",
  },
  {
    path: "packages/node-contracts/package.json",
    blob: "9caa357061eea34b411f7122f6a72438260ab4c1",
  },
  {
    path: "packages/node-core/package.json",
    blob: "58825b3bed87f07dddc774e126cab2a03bf951ce",
  },
  {
    path: "packages/node-shared/package.json",
    blob: "027aa77f1a84c2c0feae57d69d5f04068175af65",
  },
  {
    path: "packages/node-streams/package.json",
    blob: "d2b42baba977fd1f1ddaec2f6d25aa3f341843c9",
  },
  {
    path: "packages/node-ui-kit/package.json",
    blob: "86788d7e107f4b304d696ca3b159f6289cc1a593",
  },
  {
    path: "packages/operator-wallet/package.json",
    blob: "3fe0db211ccebfc808a5e07ccc14f6efd8fc89b7",
  },
  {
    path: "packages/repo-spec/package.json",
    blob: "ea4fe255429844b41a98295edf7223264f1c344c",
  },
  {
    path: "packages/scheduler-core/package.json",
    blob: "900e9d4773b97d90f19c9de658e171a2f6ea8bb9",
  },
  {
    path: "packages/work-items/package.json",
    blob: "fc2bbc5b368439a2ba19b3788a0b38f00dea7c7f",
  },
  {
    path: "pnpm-lock.yaml",
    blob: "7a942435b6eed5550c074ff81f449e54e3c7a806",
  },
  {
    path: "pnpm-workspace.yaml",
    blob: "0abe32f344e31ec6bd930ee0f6c0832052167b38",
  },
];
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--verify-inputs-only")
);
const hash = (bytes) =>
  createHash("sha1")
    .update(Buffer.from("blob " + bytes.length + "\0"))
    .update(bytes)
    .digest("hex");

function verifyInputs() {
  assert.equal(INPUTS.length, 36);
  for (const directory of ["app", "graphs", "packages"]) {
    const stat = lstatSync(directory);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Unexpected workspace directory: " + directory
    );
  }
  assert.deepEqual(
    readdirSync(".").filter(
      (name) => name === ".npmrc" || name.startsWith(".pnpmfile")
    ),
    []
  );
  assert(!existsSync("patches"), "Unexpected root package patch input");
  const members = ["app/package.json", "graphs/package.json", "package.json"];
  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      "Unexpected workspace symlink: " + entry.name
    );
    if (
      entry.isDirectory() &&
      existsSync(join("packages", entry.name, "package.json"))
    ) {
      members.push("packages/" + entry.name + "/package.json");
    }
  }
  assert.deepEqual(
    members.sort(),
    INPUTS.filter((input) => input.path.endsWith("package.json"))
      .map((input) => input.path)
      .sort()
  );
  for (const input of INPUTS) {
    const stat = lstatSync(input.path);
    assert(
      stat.isFile() && !stat.isSymbolicLink(),
      "Unexpected metadata type: " + input.path
    );
    assert.equal(
      stat.mode & 0o111,
      0,
      "Unexpected executable metadata: " + input.path
    );
    assert.equal(
      hash(readFileSync(input.path)),
      input.blob,
      "Metadata drift: " + input.path
    );
  }
}

verifyInputs();
if (args[0] === "--verify-inputs-only") {
  console.log(
    "Verified36 current metadata inputs,34 workspace manifests; no source mutation"
  );
} else {
  const negativeRoot = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "repo-spec-lock-negative-")
  );
  try {
    for (const input of INPUTS) {
      const destination = join(negativeRoot, input.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(input.path, destination);
    }
    const file = join(negativeRoot, "packages/repo-spec/package.json");
    const spec = JSON.parse(readFileSync(file, "utf8"));
    spec.dependencies.yaml = "0.0.0-frozen-negative";
    writeFileSync(file, JSON.stringify(spec));
    const outputs = [
      "github-output",
      "build-manifest.json",
      "node-artifact-bundle.json",
    ].map((name) => join(negativeRoot, name));
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "@cogni/repo-spec...",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.dedupe-peer-dependents=false",
      ],
      {
        cwd: negativeRoot,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 2_097_152,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputs[0],
          MANIFEST_FILE: outputs[1],
          BUNDLE_FILE: outputs[2],
        },
      }
    );
    assert(
      !result.error && result.status !== null,
      "Frozen negative did not finish within its bound"
    );
    assert.notEqual(
      result.status,
      0,
      "Frozen install accepted a mismatched lockfile"
    );
    const diagnostic = result.stdout + result.stderr;
    const code = "ERR_PNPM_OUTDATED_LOCKFILE";
    assert(
      diagnostic.includes(code),
      "Expected " +
        code +
        "; actual codes: " +
        (diagnostic.match(/ERR_PNPM_[A-Z_]+/g) ?? []).join(",")
    );
    assert(
      outputs.every((output) => !existsSync(output)),
      "Frozen negative wrote build outputs"
    );
    verifyInputs();
    console.log(
      code +
        ": real mismatched frozen install rejected before build outputs; source unchanged"
    );
  } finally {
    rmSync(negativeRoot, { recursive: true, force: true });
  }
}
