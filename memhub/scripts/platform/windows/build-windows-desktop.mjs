#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../run-command.mjs";
import {
  assertWindowsBuildHost,
  buildWindowsCore,
} from "./build-windows-core.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { assertSemver, resolveBuildVersion, resolveBuildNumber } =
  require("../../release-version.cjs");

export function windowsDesktopArtifactName(version) {
  assertSemver(version);
  return `MemHub-v${version}-windows-x64-setup.exe`;
}

export function windowsExecutableVersion(version, buildNumber) {
  assertSemver(version);
  const parts = version.split(/[+-]/, 1)[0].split(".").map(Number);
  if (
    !Number.isSafeInteger(buildNumber) ||
    [...parts, buildNumber].some((value) => value < 0 || value > 65535)
  ) {
    throw new Error("windows_executable_version_invalid");
  }
  return [...parts, buildNumber].join(".");
}

export async function sha256File(target) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  return digest.digest("hex");
}

function gitCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("windows_build_commit_invalid");
  return commit;
}

export async function buildWindowsDesktop(options) {
  assertWindowsBuildHost();
  if (!["dir", "nsis"].includes(options.target)) {
    throw new Error("windows_desktop_target_invalid");
  }
  const output = path.resolve(options.output);
  const version = resolveBuildVersion(process.env, root);
  const buildNumber = resolveBuildNumber(process.env, root);
  const commit = gitCommit();
  const env = {
    ...process.env,
    ONE_MEMORY_VERSION: version,
    ONE_MEMORY_BUILD_NUMBER: String(buildNumber),
    ONE_MEMORY_COMMIT: commit,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  const app = path.join(output, "win-unpacked", "MemHub.exe");
  const resources = path.join(output, "win-unpacked", "resources");
  const core = path.join(resources, "core", "one-memory.exe");
  const asar = path.join(resources, "app.asar");
  const receiptPath = path.join(output, "windows-build-receipt.json");
  await mkdir(output, { recursive: true });
  const pnpm = (args) => runCommand("pnpm", args, { cwd: root, env });

  if (options.prepackaged) {
    const previous = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      options.target !== "nsis" ||
      previous.version !== version ||
      previous.build_number !== buildNumber ||
      previous.git_commit !== commit ||
      previous.platform !== "win32" ||
      previous.arch !== "x64" ||
      previous.core_sha256 !== (await sha256File(core)) ||
      previous.app_asar_sha256 !== (await sha256File(asar)) ||
      previous.app_sha256 !== (await sha256File(app))
    ) {
      throw new Error("windows_prepackaged_identity_mismatch");
    }
  } else {
    await buildWindowsCore(env);
    await pnpm(["--filter", "@one-memory/web", "build"]);
    await pnpm(["--filter", "@one-memory/desktop", "build"]);
  }
  await pnpm([
    "--filter",
    "@one-memory/desktop",
    "exec",
    "electron-builder",
    "--win",
    ...(options.target === "nsis" ? ["nsis"] : []),
    "--x64",
    ...(options.target === "dir" ? ["--dir"] : []),
    ...(options.prepackaged ? ["--prepackaged", path.dirname(app)] : []),
    `-c.directories.output=${output}`,
    `-c.extraMetadata.version=${version}`,
    "-c.extraMetadata.productName=MemHub",
    `-c.buildVersion=${windowsExecutableVersion(version, buildNumber)}`,
  ]);
  for (const target of [app, core, asar]) {
    if (!(await lstat(target)).isFile())
      throw new Error("windows_desktop_payload_missing");
  }
  const receipt = {
    schema_version: 1,
    product: "memhub-windows-desktop-build",
    version,
    build_number: buildNumber,
    git_commit: commit,
    platform: "win32",
    arch: "x64",
    target: options.target,
    signing: "unsigned",
    app_update: "manual",
    core_layout: "folder",
    result: "built",
    core_sha256: await sha256File(core),
    app_sha256: await sha256File(app),
    app_asar_sha256: await sha256File(asar),
  };
  if (options.target === "nsis") {
    const filename = windowsDesktopArtifactName(version);
    const installer = path.join(output, filename);
    const info = await lstat(installer);
    if (!info.isFile() || info.size === 0)
      throw new Error("windows_installer_missing");
    const hash = await sha256File(installer);
    receipt.installer = { filename, sha256: hash, bytes: info.size };
    await writeFile(
      path.join(output, "checksums.txt"),
      `${hash}  ${filename}\n`,
    );
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function parseArguments(args) {
  const options = {
    output: path.join(root, "build/windows-desktop"),
    target: "nsis",
    prepackaged: false,
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--prepackaged") options.prepackaged = true;
    else if (flag === "--target" || flag === "--output") {
      const value = args[++index];
      if (!value) throw new Error(`missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWindowsDesktop(parseArguments(process.argv.slice(2))).then(
    (receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    },
  );
}
