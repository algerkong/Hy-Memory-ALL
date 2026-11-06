import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPrivatePath } from "@one-memory/host-bridge";

interface ProcessIdentity {
  dataDir: string;
  kind: "core" | "runtime";
  pid: number;
  instanceId: string;
}

export function windowsProcessStopPath(identity: ProcessIdentity): string {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.instanceId) ||
    !["core", "runtime"].includes(identity.kind)
  )
    throw new Error("process_stop_identity_invalid");
  return path.join(
    identity.dataDir,
    `.memhub-${identity.kind}-stop-${identity.pid}.json`,
  );
}

/** Windows SIGTERM is TerminateProcess, so request a graceful, identity-bound stop. */
export async function requestWindowsProcessStop(
  identity: ProcessIdentity,
): Promise<void> {
  const target = windowsProcessStopPath(identity);
  await assertPrivatePath(identity.dataDir, "directory");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) await assertPrivatePath(target, "file");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        pid: identity.pid,
        instance_id: identity.instanceId,
      }),
      { flag: "wx", mode: 0o600, flush: true },
    );
    await assertPrivatePath(temporary, "file");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function waitForWindowsProcessStop(
  identity: ProcessIdentity,
  signal: AbortSignal,
): Promise<void> {
  const target = windowsProcessStopPath(identity);
  while (!signal.aborted) {
    try {
      const info = await lstat(target);
      if (info.isFile() && info.size <= 2048) {
        await assertPrivatePath(identity.dataDir, "directory");
        await assertPrivatePath(target, "file");
        const value: unknown = JSON.parse(await readFile(target, "utf8"));
        if (
          value !== null &&
          typeof value === "object" &&
          Object.keys(value).length === 2 &&
          "pid" in value &&
          "instance_id" in value &&
          value.pid === identity.pid &&
          value.instance_id === identity.instanceId
        ) {
          await rm(target);
          return;
        }
      }
    } catch {
      // Missing, unsafe and stale requests never stop an unrelated process.
    }
    try {
      await delay(100, undefined, { signal });
    } catch {
      return;
    }
  }
}
