import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertWindowsBuildHost } from "./build-windows-core.mjs";
import {
  windowsDesktopArtifactName,
  windowsExecutableVersion,
} from "./build-windows-desktop.mjs";

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
