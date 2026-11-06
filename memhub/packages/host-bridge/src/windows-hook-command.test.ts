import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { failOpenHookCommand } from "./capture-hooks.js";
import { injectionHookCommand } from "./codebuddy-plugin.js";
import { windowsHookCommand } from "./windows-hook-command.js";

function script(command: string): string {
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded ?? "", "base64").toString("utf16le");
}

it("renders native Windows capture without a POSIX shell or inline environment syntax", () => {
  const command = failOpenHookCommand(
    "C:\\Program Files\\MemHub\\one-memory.exe",
    "capture codex",
    "silent",
    "C:\\Users\\Example\\memory \u6d4b\u8bd5",
    "win32",
  );
  expect(command).not.toContain("sh -c");
  expect(script(command)).toContain(
    "$env:ONE_MEMORY_DATA_DIR = 'C:\\Users\\Example\\memory \u6d4b\u8bd5'",
  );
  expect(script(command)).toContain("'capture' 'codex'");
  expect(script(command)).toContain("$ProgressPreference = 'SilentlyContinue'");
  expect(script(command)).toContain("exit 0");
});

it("carries the same credential and Node mode into Windows injection", () => {
  const command = injectionHookCommand(
    {
      runtimeCommand: "C:\\MemHub\\MemHub.exe",
      recallCliPath: "C:\\MemHub\\resources\\host-bridge\\recall-cli.cjs",
      discoveryPath: "C:\\memory\\broker.json",
      credentialFile: "C:\\memory\\credential",
    },
    "win32",
  );
  const decoded = script(command);
  expect(decoded).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
  expect(decoded).toContain(
    "$env:ONE_MEMORY_HOST_CREDENTIAL_FILE = 'C:\\memory\\credential'",
  );
  expect(decoded).toContain("'--inject' 'workbuddy'");
});

it("keeps path data literal and refuses control characters", () => {
  expect(
    script(
      windowsHookCommand(
        "C:\\O'Brien\\core.exe",
        ["capture", "codex"],
        "silent",
        {},
      ),
    ),
  ).toContain("'C:\\O''Brien\\core.exe'");
  expect(() =>
    windowsHookCommand("core.exe\nexit 1", [], "silent", {}),
  ).toThrow("invalid");
});

it.runIf(process.platform === "win32")(
  "passes UTF-8 stdin and suppresses failed hook output on Windows",
  () => {
    const echo = windowsHookCommand(
      process.execPath,
      [
        "-e",
        "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d));",
      ],
      "context",
      {},
    );
    const input = JSON.stringify({ text: "\u4f60\u597d Windows" });
    const result = spawnSync(echo, {
      shell: true,
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual(JSON.parse(input));
    const failed = windowsHookCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('hidden');process.stderr.write('hidden');process.exit(13)",
      ],
      "context",
      {},
    );
    const failure = spawnSync(failed, {
      shell: true,
      input: "{}",
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(failure.status).toBe(0);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toBe("");
  },
  30_000,
);
