import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandInvocation, runCommand } from "./run-command.mjs";

test("pnpm runs its JavaScript entrypoint without cmd.exe quoting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memhub-command-"));
  try {
    const entry = path.join(root, "pnpm with spaces.cjs");
    await writeFile(entry, "");
    const args = ["--dir", "C:\\Build path\\project", "build"];
    assert.deepEqual(
      commandInvocation("pnpm", args, {
        platform: "win32",
        environment: { npm_execpath: entry },
      }),
      { command: process.execPath, args: [entry, ...args] },
    );
    assert.throws(
      () =>
        commandInvocation("pnpm", [], { platform: "win32", environment: {} }),
      /pnpm_entrypoint_missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native commands preserve arguments and report failure", async () => {
  await runCommand(process.execPath, [
    "-e",
    "if (process.argv[1] !== 'a & b with spaces') process.exit(1)",
    "a & b with spaces",
  ]);
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(7)"]),
    /failed \(7\)/,
  );
});
