import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { protectWindowsPrivatePath } from "@one-memory/host-bridge";
import { expect, it } from "vitest";
import {
  requestWindowsProcessStop,
  waitForWindowsProcessStop,
  windowsProcessStopPath,
} from "./windows-process-stop.js";

it("binds a graceful Windows stop to the exact process and instance", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memhub-stop-"));
  await chmod(dataDir, 0o700);
  await protectWindowsPrivatePath(dataDir, "directory");
  const current = {
    dataDir,
    kind: "runtime" as const,
    pid: 4321,
    instanceId: "current",
  };
  const abort = new AbortController();
  let stopped = false;
  const waiting = waitForWindowsProcessStop(current, abort.signal).then(() => {
    stopped = true;
  });
  try {
    await requestWindowsProcessStop({ ...current, instanceId: "previous" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stopped).toBe(false);
    await requestWindowsProcessStop(current);
    await waiting;
    expect(stopped).toBe(true);
  } finally {
    abort.abort();
    await waiting;
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("does not accept a path in a process identity", () => {
  expect(() =>
    windowsProcessStopPath({
      dataDir: "/tmp",
      kind: "core",
      pid: 4321,
      instanceId: "../../other",
    }),
  ).toThrow("process_stop_identity_invalid");
});
