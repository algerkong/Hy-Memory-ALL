import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPrivatePath,
  protectWindowsPrivatePath,
} from "@one-memory/host-bridge";
import { expect, it } from "vitest";
import { PersistentBatchLedger } from "./connection-batch-ledger.js";

it.runIf(process.platform === "win32")(
  "reopens private connection journals and keeps their compare-and-swap revision on NTFS",
  async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "memhub-windows-ledger-"),
    );
    try {
      await protectWindowsPrivatePath(dataDir, "directory");
      const owner = { userId: "local", runtimeId: "windows-data-instance" };
      const journal = {
        schemaVersion: 1 as const,
        ...owner,
        operationId: "windows-operation",
        planDigest: "a".repeat(64),
        revision: 1,
        items: [
          {
            id: "install",
            kind: "install" as const,
            intentDigest: "a".repeat(64),
            state: "pending" as const,
            receipt: null,
          },
        ],
      };
      const ledger = await PersistentBatchLedger.initialize(dataDir, owner);
      await ledger.exclusive(owner, () =>
        ledger.commit(owner, journal.operationId, null, journal),
      );
      const reopened = await PersistentBatchLedger.open(dataDir, owner);
      expect(await reopened.load(owner, journal.operationId)).toEqual(journal);
      await expect(
        reopened.exclusive(owner, () =>
          reopened.commit(owner, journal.operationId, null, journal),
        ),
      ).rejects.toThrow("revision_conflict");
      await assertPrivatePath(
        path.join(dataDir, "connection-batches", "owner.json"),
        "file",
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
