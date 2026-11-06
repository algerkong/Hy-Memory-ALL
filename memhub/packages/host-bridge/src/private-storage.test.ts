import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPrivatePath,
  assertWindowsPrivateAcl,
  protectWindowsPrivatePath,
} from "./private-storage.js";

const roots: string[] = [];
const sid = "S-1-5-21-123-456-789-1001";
function inspection() {
  return {
    current_sid: sid,
    owner_sid: sid,
    reparse: false,
    current_user_full_control: true,
    rules: [
      { sid, allow: true, rights: 0x1f01ff },
      { sid: "S-1-5-18", allow: true, rights: 0x1f01ff },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows private storage", () => {
  it("accepts a current-user ACL and trusted OS principals", () => {
    expect(() => assertWindowsPrivateAcl(inspection())).not.toThrow();
  });

  it.each([
    null,
    {},
    { ...inspection(), owner_sid: "S-1-5-21-999-1002" },
    { ...inspection(), reparse: true },
    { ...inspection(), current_user_full_control: false },
    { ...inspection(), rules: [] },
    { ...inspection(), rules: [null] },
    { ...inspection(), rules: [{ sid, allow: false, rights: 1 }] },
    {
      ...inspection(),
      rules: [
        ...inspection().rules,
        { sid: "S-1-1-0", allow: true, rights: 1 },
      ],
    },
    {
      ...inspection(),
      rules: [
        ...inspection().rules,
        { sid: "S-1-5-11", allow: true, rights: 0x1f01ff },
      ],
    },
  ])("refuses unsafe or malformed ACL evidence: %j", (value) => {
    expect(() => assertWindowsPrivateAcl(value)).toThrow();
  });

  it.runIf(process.platform === "win32")(
    "protects and reads real NTFS paths with spaces and Unicode",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "memhub-private-"));
      roots.push(root);
      const directory = path.join(root, "memory \u6d4b\u8bd5");
      await mkdir(directory);
      await protectWindowsPrivatePath(directory, "directory");
      await expect(
        assertPrivatePath(directory, "directory"),
      ).resolves.toBeDefined();
      const file = path.join(directory, "credential");
      await writeFile(file, "private");
      await expect(assertPrivatePath(file, "file")).resolves.toBeDefined();
    },
  );
});
