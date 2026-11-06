#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../run-command.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function assertWindowsBuildHost(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error("windows_desktop_build_requires_native_windows_x64");
  }
}

export async function buildWindowsCore(environment = process.env) {
  assertWindowsBuildHost();
  const env = { ...environment, ONE_MEMORY_CORE_LAYOUT: "folder" };
  const run = (args) => runCommand("uv", args, { cwd: root, env });
  await run(["sync", "--directory", "apps/core", "--all-groups", "--locked"]);
  await run([
    "run",
    "--directory",
    "apps/core",
    "python",
    path.join(root, "scripts/fetch_embedding_model.py"),
  ]);
  await run([
    "run",
    "--directory",
    "apps/core",
    "python",
    path.join(root, "scripts/fetch_embedding_model.py"),
    "--verify-only",
  ]);
  await run([
    "run",
    "--directory",
    "apps/core",
    "pyinstaller",
    "--clean",
    "--noconfirm",
    "one-memory.spec",
  ]);
  const executable = path.join(
    root,
    "apps/core/dist/one-memory-runtime/one-memory.exe",
  );
  if (!(await lstat(executable)).isFile()) {
    throw new Error("windows_core_executable_missing");
  }
  return executable;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWindowsCore().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
