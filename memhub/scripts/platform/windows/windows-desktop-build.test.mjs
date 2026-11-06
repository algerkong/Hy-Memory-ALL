import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertWindowsBuildHost } from "./build-windows-core.mjs";
import {
  windowsDesktopArtifactName,
  windowsExecutableVersion,
} from "./build-windows-desktop.mjs";
import { runWindowsSmokeStep } from "./smoke-windows-desktop.mjs";

test("Windows desktop requires native x64 and preserves the preview version", () => {
  assert.doesNotThrow(() => assertWindowsBuildHost("win32", "x64"));
  assert.throws(
    () => assertWindowsBuildHost("darwin", "x64"),
    /native_windows_x64/,
  );
  assert.throws(
    () => assertWindowsBuildHost("win32", "arm64"),
    /native_windows_x64/,
  );
  assert.equal(
    windowsDesktopArtifactName("1.0.7-windows.1"),
    "MemHub-v1.0.7-windows.1-windows-x64-setup.exe",
  );
  assert.equal(windowsExecutableVersion("1.0.7-windows.1", 45), "1.0.7.45");
  assert.throws(() => windowsExecutableVersion("1.0.7", 65536), /invalid/);
});

test("NSIS is per-user, preserves data and uses the existing bitmap icon", async () => {
  const pkg = JSON.parse(
    await readFile(
      new URL("../../../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pkg.build.win.icon, "assets/icon.png");
  assert.deepEqual(pkg.build.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(pkg.build.win.requestedExecutionLevel, "asInvoker");
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.runAfterFinish, false);
});

test("Windows smoke steps record results without leaking action values", async () => {
  const events = [];
  assert.equal(
    await runWindowsSmokeStep(
      "first-launch",
      "identity",
      () => "private-token",
      {
        events,
      },
    ),
    "private-token",
  );
  assert.equal(events[0].result, "passed");
  assert.ok(events[0].duration_ms >= 0);
  assert.ok(!JSON.stringify(events).includes("private-token"));
  await assert.rejects(
    runWindowsSmokeStep(
      "first-launch",
      "identity-error",
      () => {
        throw new Error("identity_failed");
      },
      { events },
    ),
    /identity_failed/,
  );
  assert.equal(events[1].result, "failed");
});

test("Windows smoke steps time out even when an Electron operation never settles", async () => {
  const events = [];
  await assert.rejects(
    runWindowsSmokeStep(
      "first-launch",
      "blocked-ipc",
      () => new Promise(() => {}),
      {
        events,
        timeout: 20,
      },
    ),
    /windows_smoke_timeout:first-launch:blocked-ipc/,
  );
  assert.equal(events[0].result, "failed");
  assert.equal(
    events[0].error,
    "windows_smoke_timeout:first-launch:blocked-ipc",
  );
});
