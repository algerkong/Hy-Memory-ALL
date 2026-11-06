#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../run-command.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const pnpm = (args) => runCommand("pnpm", args, { cwd: root });

try {
  await runCommand(process.execPath, ["scripts/assert-test-isolation.mjs"], {
    cwd: root,
  });
  await pnpm([
    "--filter",
    "@one-memory/host-bridge",
    "test",
    "src/private-storage.test.ts",
    "src/windows-hook-command.test.ts",
    "src/windows-host-grants.test.ts",
    "--testTimeout=30000",
  ]);
  await pnpm([
    "--filter",
    "@one-memory/runtime-control",
    "test",
    "src/windows-process-stop.test.ts",
    "src/windows-desktop-storage.test.ts",
    "src/runtime-launcher.test.ts",
    "src/runtime-supervisor.test.ts",
    "--testTimeout=30000",
  ]);
  await pnpm([
    "--filter",
    "@one-memory/desktop",
    "test",
    "src/windows-login-item.test.ts",
    "src/windows-desktop-isolation.test.ts",
    "src/background-tray.test.ts",
    "src/desktop-lifecycle.test.ts",
    "src/connection-setup-remote.test.ts",
    "--testTimeout=30000",
  ]);
  await runCommand(
    "uv",
    [
      "run",
      "--directory",
      "apps/core",
      "pytest",
      "-q",
      "tests/test_windows_desktop.py",
      "tests/test_windows_process_control.py",
      "tests/test_parent_watchdog.py",
      "tests/test_cursor_default_root_windows.py",
      "tests/test_memory_server_config_state.py",
      `--junitxml=${path.join(root, "build/windows-tests/core-junit.xml")}`,
    ],
    { cwd: root },
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
