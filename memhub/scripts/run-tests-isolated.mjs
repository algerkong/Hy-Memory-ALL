#!/usr/bin/env node

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reservedPorts = new Set([8765, 18765]);

function insideWindows(candidate, parent) {
  const relative = path.win32.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.win32.sep}`) &&
      relative !== ".." &&
      !path.win32.isAbsolute(relative))
  );
}

export function windowsIsolationEnvironment({
  runRoot,
  realHome,
  corePort,
  brokerPort,
  environment = process.env,
}) {
  if (
    !path.win32.isAbsolute(runRoot) ||
    !path.win32.isAbsolute(realHome) ||
    insideWindows(runRoot, realHome) ||
    /[\0\r\n]/.test(runRoot + realHome)
  ) {
    throw new Error(
      "test_temp_root_unsafe: set ONE_MEMORY_TEST_TEMP_ROOT outside your user profile",
    );
  }
  for (const port of [corePort, brokerPort]) {
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      reservedPorts.has(port)
    ) {
      throw new Error("test_port_unsafe");
    }
  }
  if (corePort === brokerPort) throw new Error("test_ports_must_differ");
  const home = path.win32.join(runRoot, "home");
  return {
    ...environment,
    ONE_MEMORY_TEST_ISOLATED: "1",
    ONE_MEMORY_TEST_REAL_HOME: realHome,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.win32.parse(home).root.replace(/\\$/, ""),
    HOMEPATH: home.slice(path.win32.parse(home).root.length - 1),
    APPDATA: path.win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.win32.join(home, "AppData", "Local"),
    ONE_MEMORY_DATA_DIR: path.win32.join(runRoot, "data"),
    ONE_MEMORY_SOURCE_HOME: home,
    ONE_MEMORY_HOST_HOME: home,
    XDG_CONFIG_HOME: path.win32.join(runRoot, "config"),
    XDG_CACHE_HOME: path.win32.join(runRoot, "cache"),
    XDG_DATA_HOME: path.win32.join(home, ".local", "share"),
    TMP: path.win32.join(runRoot, "tmp"),
    TEMP: path.win32.join(runRoot, "tmp"),
    TMPDIR: path.win32.join(runRoot, "tmp"),
    COREPACK_HOME:
      environment.COREPACK_HOME ??
      path.win32.join(realHome, "AppData", "Local", "node", "corepack"),
    ONE_MEMORY_PORT: String(corePort),
    ONE_MEMORY_CORE_PORT: String(corePort),
    ONE_MEMORY_RUNTIME_PORT: String(corePort),
    ONE_MEMORY_BROKER_PORT: String(brokerPort),
  };
}

async function unusedPort() {
  const server = net.createServer();
  try {
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    if (reservedPorts.has(port)) throw new Error("test_port_reserved");
    return port;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runCore(mode, args, env) {
  const markers = {
    "core-fast": "unit or contract",
    "core-integration": "integration",
    "core-pr": "not performance and not live",
    "core-performance": "performance",
    "core-live": "live",
  };
  if (!["core", "core-all", ...Object.keys(markers)].includes(mode)) {
    throw new Error(`unsupported_windows_test_mode: ${mode}`);
  }
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const report =
    env.ONE_MEMORY_TEST_REPORT_DIR ??
    path.join(root, "build", "test-reports", "core", `${mode}-${stamp}`);
  await mkdir(report, { recursive: true });
  const uv = (args) => runCommand("uv", args, { cwd: root, env });
  await uv([
    "run",
    "--directory",
    "apps/core",
    "python",
    path.join(root, "scripts/generate_core_test_index.py"),
    "--check",
  ]);
  let failure;
  try {
    await uv([
      "run",
      "--directory",
      "apps/core",
      "pytest",
      "--durations=100",
      "--durations-min=0.05",
      `--junitxml=${path.join(report, "junit.xml")}`,
      `--core-report-dir=${report}`,
      `--core-suite=${mode}`,
      ...(markers[mode] ? ["-m", markers[mode]] : []),
      ...args,
    ]);
  } catch (error) {
    failure = error;
  }
  await uv([
    "run",
    "--directory",
    "apps/core",
    "python",
    path.join(root, "scripts/audit_core_test_design.py"),
    report,
    path.join(root, "apps/core/tests"),
  ]);
  if (failure) throw failure;
}

export async function runIsolatedTests(args) {
  if (process.platform !== "win32") {
    await runCommand("bash", ["scripts/run-tests-isolated.sh", ...args], {
      cwd: root,
    });
    return;
  }
  const realHome = await realpath(
    process.env.ONE_MEMORY_TEST_REAL_HOME ?? os.userInfo().homedir,
  );
  const temporaryRoot = await realpath(
    process.env.ONE_MEMORY_TEST_TEMP_ROOT ??
      process.env.RUNNER_TEMP ??
      os.tmpdir(),
  );
  if (insideWindows(temporaryRoot, realHome)) {
    throw new Error(
      "test_temp_root_unsafe: set ONE_MEMORY_TEST_TEMP_ROOT outside your user profile",
    );
  }
  const runRoot = await mkdtemp(path.join(temporaryRoot, "one-memory-tests."));
  try {
    const corePort = await unusedPort();
    let brokerPort = await unusedPort();
    while (brokerPort === corePort) brokerPort = await unusedPort();
    const env = windowsIsolationEnvironment({
      runRoot,
      realHome,
      corePort,
      brokerPort,
    });
    for (const target of [
      env.HOME,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.ONE_MEMORY_DATA_DIR,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
      env.TEMP,
    ]) {
      await mkdir(target, { recursive: true });
    }
    await runCommand(process.execPath, ["scripts/assert-test-isolation.mjs"], {
      cwd: root,
      env,
    });
    const [mode = "workspace", ...rest] = args;
    if (mode === "self-test") {
      process.stdout.write(
        `test isolation ready: HOME=${env.HOME} data=${env.ONE_MEMORY_DATA_DIR} ports=${corePort}/${brokerPort} COREPACK_HOME=${env.COREPACK_HOME}\n`,
      );
    } else if (mode === "pnpm" || mode === "node") {
      await runCommand(mode === "node" ? process.execPath : mode, rest, {
        cwd: root,
        env,
      });
    } else if (mode === "workspace") {
      await runCommand("pnpm", ["-r", "test", ...rest], { cwd: root, env });
    } else {
      await runCore(mode, rest, env);
    }
  } finally {
    await rm(runRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runIsolatedTests(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
