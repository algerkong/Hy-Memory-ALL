import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setReleaseVersion } from "./set-release-version.mjs";
import { verifyReleaseVersion } from "./verify-release-version.mjs";

const require = createRequire(import.meta.url);
const { pythonPackageVersion } = require("./release-version.cjs");
const rootPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const currentVersion = rootPackage.version;
const currentBuildNumber = rootPackage.release.build_number;
const currentPythonVersion = pythonPackageVersion(currentVersion);

async function fixture(version, t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memhub-version-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = await verifyReleaseVersion(["--channel", "development"], {});
  for (const relative of Object.keys(current.files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(new URL(`../${relative}`, import.meta.url), target);
  }
  await setReleaseVersion(version, root, 7);
  return root;
}

test("development accepts the synchronized source version", async () => {
  const receipt = await verifyReleaseVersion(["--channel", "development"], {});
  assert.equal(receipt.version, currentVersion);
  assert.equal(receipt.build_number, currentBuildNumber);
  for (const [file, version] of Object.entries(receipt.files)) {
    assert.equal(
      version,
      file.startsWith("apps/core/") ? currentPythonVersion : currentVersion,
    );
  }
});

test("stable accepts the exact tag and build number", async (t) => {
  const root = await fixture("1.2.3", t);
  const receipt = await verifyReleaseVersion(
    ["--channel", "stable", "--tag", "v1.2.3", "--build-number", "7"],
    {},
    root,
  );
  assert.equal(receipt.version, "1.2.3");
  assert.equal(receipt.build_number, 7);
});

test("prerelease rejects a stable source version", async (t) => {
  const root = await fixture("1.2.3", t);
  await assert.rejects(
    verifyReleaseVersion(
      ["--channel", "prerelease", "--tag", "v1.2.3", "--build-number", "7"],
      {},
      root,
    ),
    /prerelease channel requires a SemVer prerelease/,
  );
});

test("Windows prerelease is accepted only in the prerelease channel", async (t) => {
  const root = await fixture("1.2.3-windows.1", t);
  const args = ["--tag", "v1.2.3-windows.1", "--build-number", "7"];
  const receipt = await verifyReleaseVersion(
    ["--channel", "prerelease", ...args],
    {},
    root,
  );
  assert.equal(receipt.python_version, "1.2.3.dev1+windows");
  await assert.rejects(
    verifyReleaseVersion(["--channel", "stable", ...args], {}, root),
    /stable channel cannot publish prerelease/,
  );
});
test("an environment override cannot drift from the source version", async () => {
  await assert.rejects(
    verifyReleaseVersion(["--channel", "development"], {
      ONE_MEMORY_VERSION: "1.2.3",
    }),
    /does not match root|release version mismatch/,
  );
});

test("a build number override cannot drift from the release contract", async () => {
  await assert.rejects(
    verifyReleaseVersion(["--channel", "development"], {
      ONE_MEMORY_BUILD_NUMBER: String(currentBuildNumber + 1),
    }),
    /release build number mismatch/,
  );
});

test("the verifier source checks every release-bearing manifest", async () => {
  const source = await readFile(
    new URL("./verify-release-version.mjs", import.meta.url),
    "utf8",
  );
  for (const file of [
    "apps/cli/package.json",
    "apps/desktop/package.json",
    "packages/runtime-control/package.json",
    "apps/core/pyproject.toml",
  ]) {
    assert.match(source, new RegExp(file.replaceAll("/", "\\/")));
  }
});
