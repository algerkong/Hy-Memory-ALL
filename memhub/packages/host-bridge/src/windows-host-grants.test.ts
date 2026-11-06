import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { HostGrantStore } from "./host-grants.js";
import { assertPrivatePath } from "./private-storage.js";

it.runIf(process.platform === "win32")(
  "persists a native Windows host credential without granting content implicitly",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memhub-windows-grants-"));
    try {
      const directory = path.join(root, "grants \u6d4b\u8bd5");
      const store = await HostGrantStore.initialize(directory);
      const issued = await store.createInstallation({ hostId: "cursor" });
      expect(issued.receipt.status).toBe("install-only");
      expect(JSON.stringify(issued)).not.toContain(issued.secret);
      await assertPrivatePath(path.join(directory, "host-grants.json"), "file");
      const reopened = await HostGrantStore.open(directory);
      expect(await reopened.listInstallations()).toEqual([issued.receipt]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
