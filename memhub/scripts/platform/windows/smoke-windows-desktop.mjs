#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../run-command.mjs";
import { windowsIsolationEnvironment } from "../../run-tests-isolated.mjs";
import { assertWindowsBuildHost } from "./build-windows-core.mjs";
import { sha256File } from "./build-windows-desktop.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const { _electron: electron } = require("playwright-core");
const { resolveBuildVersion, resolveBuildNumber } = require(
  path.join(root, "scripts/release-version.cjs"),
);

export async function runWindowsSmokeStep(
  phase,
  step,
  action,
  { events = [], timeout = 30_000 } = {},
) {
  const started = Date.now();
  const event = { phase, step, result: "running" };
  events.push(event);
  process.stdout.write(`[windows-smoke] ${phase}:${step}\n`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`windows_smoke_timeout:${phase}:${step}`)),
          timeout,
        );
      }),
    ]);
    event.result = "passed";
    return result;
  } catch (error) {
    event.result = "failed";
    event.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(timer);
    event.duration_ms = Date.now() - started;
  }
}

async function waitFor(check, message, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(message);
}

async function unusedPort() {
  const server = net.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function exists(target) {
  return access(target).then(
    () => true,
    () => false,
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runtimeReady(dataDir) {
  let value;
  await waitFor(
    async () => {
      try {
        const receipt = JSON.parse(
          await readFile(path.join(dataDir, "runtime-service.json"), "utf8"),
        );
        const core = JSON.parse(
          await readFile(path.join(dataDir, "runtime.json"), "utf8"),
        );
        const token = (
          await readFile(path.join(dataDir, "runtime-token"), "utf8")
        ).trim();
        if (
          receipt.status !== "running" ||
          !Number.isInteger(receipt.core_port) ||
          !token
        )
          return false;
        const response = await fetch(
          `http://127.0.0.1:${receipt.core_port}/api/v1/runtime/identity`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (!response.ok) return false;
        const identity = await response.json();
        if (
          identity.service !== "one-memory-core" ||
          identity.instance_id !== receipt.instance_id
        )
          return false;
        if (
          !Number.isInteger(receipt.pid) ||
          !Number.isInteger(core.pid) ||
          !alive(receipt.pid) ||
          !alive(core.pid)
        )
          return false;
        value = { receipt, corePid: core.pid, token };
        return true;
      } catch {
        return false;
      }
    },
    "windows_packaged_runtime_not_ready",
    180_000,
  );
  return value;
}

async function waitForRenderer(page) {
  await page.waitForFunction(
    () =>
      location.protocol === "one-memory:" &&
      location.hostname === "app" &&
      document.getElementById("root")?.childElementCount > 0 &&
      typeof window.oneMemory?.getApiBaseUrl === "function",
    undefined,
    { timeout: 120_000 },
  );
}

async function quit(application, page, state, dataDir) {
  const closed = application.waitForEvent("close", { timeout: 45_000 });
  await Promise.all([
    closed,
    page
      .evaluate(() => window.oneMemory.requestQuit(true))
      .catch((error) => {
        if (!/closed|destroyed/i.test(error.message)) throw error;
      }),
  ]);
  await waitFor(
    async () => {
      const names = [
        "runtime-service.json",
        "runtime.json",
        "runtime-token",
        "runtime-service.lock",
      ];
      return (
        !alive(state.receipt.pid) &&
        !alive(state.corePid) &&
        (
          await Promise.all(
            names.map((name) => exists(path.join(dataDir, name))),
          )
        ).every((present) => !present)
      );
    },
    "windows_packaged_shutdown_left_processes_or_receipts",
    30_000,
  );
  await waitFor(
    () => application.process().exitCode !== null,
    "windows_desktop_did_not_exit",
    5_000,
  );
  if (application.process().exitCode !== 0)
    throw new Error("windows_desktop_exit_code_nonzero");
}

async function verifyLaunch(
  executable,
  env,
  output,
  phase,
  exerciseWindow,
  events,
) {
  const step = (name, action, timeout) =>
    runWindowsSmokeStep(phase, name, action, { events, timeout });
  let application;
  const errors = [];
  const watch = (page) =>
    page.on("pageerror", (error) => errors.push(error.message));
  let page;
  let state;
  try {
    application = await step(
      "electron-launch",
      () =>
        electron.launch({
          executablePath: executable,
          env,
          timeout: 120_000,
        }),
      130_000,
    );
    for (const current of application.context().pages()) watch(current);
    application.context().on("page", watch);
    page = await step(
      "first-window",
      () => application.firstWindow({ timeout: 120_000 }),
      130_000,
    );
    state = await step(
      "runtime-ready",
      () => runtimeReady(env.ONE_MEMORY_DATA_DIR),
      190_000,
    );
    await step("renderer-ready", () => waitForRenderer(page), 130_000);
    const build = await step("build-identity", () =>
      page.evaluate(() => window.oneMemory.getBuildInfo()),
    );
    if (
      build.version !== resolveBuildVersion() ||
      build.buildNumber !== String(resolveBuildNumber())
    ) {
      throw new Error("windows_renderer_build_identity_mismatch");
    }
    const base = await step("api-port", () =>
      page.evaluate(() => window.oneMemory.getApiBaseUrl()),
    );
    if (base !== `http://127.0.0.1:${state.receipt.core_port}`) {
      throw new Error("windows_renderer_core_port_mismatch");
    }
    const startup = await step("login-preference", () =>
      page.evaluate(() => window.oneMemory.getLoginPreference()),
    );
    if (startup.enabled)
      throw new Error("windows_isolated_startup_was_enabled");
    const capability = await step("connection-capability", () =>
      page.evaluate(() => window.oneMemory.getConnectionSetupCapability()),
    );
    if (!capability.available)
      throw new Error("windows_connection_setup_not_available");
    const preference = await step("language-preference", () =>
      page.evaluate(() => window.oneMemory.getLanguagePreference()),
    );
    if (phase === "first-launch") {
      await step("save-language-preference", () =>
        page.evaluate(() => window.oneMemory.setLanguagePreference("en")),
      );
      await step(
        "database-backup",
        async () => {
          const response = await fetch(`${base}/api/v1/backup`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${state.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ target: "backups/windows-smoke.sqlite3" }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok)
            throw new Error(
              `windows_database_backup_failed:${response.status}`,
            );
          if ((await response.json()).bytes <= 0)
            throw new Error("windows_database_backup_empty");
        },
        40_000,
      );
    } else if (preference.preference !== "en") {
      throw new Error("windows_language_preference_not_preserved");
    }
    if (exerciseWindow) {
      await step("close-window", () =>
        application.evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.close();
        }),
      );
      if (!alive(state.receipt.pid) || !alive(state.corePid)) {
        throw new Error("windows_window_close_stopped_runtime");
      }
      [page] = await step(
        "restore-window",
        () =>
          Promise.all([
            application.waitForEvent("window", { timeout: 30_000 }),
            runCommand(executable, [], { env, timeout: 20_000 }),
          ]),
        40_000,
      );
      await step(
        "restored-renderer-ready",
        () => waitForRenderer(page),
        130_000,
      );
    }
    await step("screenshot", () =>
      page.screenshot({ path: path.join(output, `${phase}.png`) }),
    );
    const pixels = await step("window-pixels", () =>
      application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.isVisible(),
        );
        if (!window) throw new Error("windows_no_visible_window");
        const image = await window.webContents.capturePage();
        const bitmap = image.toBitmap();
        const colors = new Set();
        for (let index = 0; index < bitmap.length; index += 64) {
          colors.add(bitmap.subarray(index, index + 3).toString("hex"));
        }
        return { ...image.getSize(), sampled_colors: colors.size };
      }),
    );
    if (
      pixels.width < 600 ||
      pixels.height < 400 ||
      pixels.sampled_colors < 12
    ) {
      throw new Error("windows_packaged_window_blank");
    }
    if (errors.length)
      throw new Error(`windows_renderer_errors:${errors.join(";")}`);
    await step(
      "graceful-shutdown",
      () => quit(application, page, state, env.ONE_MEMORY_DATA_DIR),
      90_000,
    );
    return {
      phase,
      result: "passed",
      build,
      core_port: state.receipt.core_port,
      instance_id: state.receipt.instance_id,
      sidecar: state.receipt.sidecar,
      renderer_pixels: pixels,
      window_close_and_restore: exerciseWindow ? "passed" : "not-run",
      graceful_shutdown: "passed",
      startup_setting: "not-modified",
    };
  } catch (error) {
    if (!application) throw error;
    if (page && !page.isClosed()) {
      await step(
        "failure-screenshot",
        () =>
          page.screenshot({
            path: path.join(output, `${phase}-failure.png`),
            timeout: 5_000,
          }),
        10_000,
      ).catch(() => {});
    }
    await step("failure-close", () => application.close(), 10_000).catch(() =>
      application.process().kill(),
    );
    await step(
      "failure-runtime-stop",
      () =>
        runCommand(
          executable,
          [
            path.join(
              path.dirname(executable),
              "resources/runtime/runtime.cjs",
            ),
            "stop",
          ],
          {
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
            timeout: 30_000,
          },
        ),
      35_000,
    ).catch(() => {});
    throw error;
  }
}

export async function smokeWindowsDesktop(options) {
  assertWindowsBuildHost();
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const realHome = await realpath(os.userInfo().homedir);
  const temporaryRoot = await realpath(
    process.env.ONE_MEMORY_TEST_TEMP_ROOT ??
      process.env.RUNNER_TEMP ??
      os.tmpdir(),
  );
  const work = await mkdtemp(path.join(temporaryRoot, "memhub-windows-smoke."));
  const runRoot = path.join(work, "Memory with spaces \u6d4b\u8bd5");
  const corePort = await unusedPort();
  let brokerPort = await unusedPort();
  while (brokerPort === corePort) brokerPort = await unusedPort();
  const env = windowsIsolationEnvironment({
    runRoot,
    realHome,
    corePort,
    brokerPort,
  });
  env.ONE_MEMORY_DATA_DIR = path.join(env.HOME, ".one-memory");
  env.ONE_MEMORY_DESKTOP_TEST_HOME = env.HOME;
  env.ONE_MEMORY_KEYCHAIN_SERVICE = `memhub-windows-smoke-${randomUUID()}`;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const target of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.TEMP,
    env.ONE_MEMORY_DATA_DIR,
  ]) {
    await mkdir(target, { recursive: true });
  }
  let executable = options.app && path.resolve(options.app);
  let installed = false;
  const installRoot = path.join(work, "Installed MemHub \u6d4b\u8bd5");
  const receipt = {
    schema_version: 1,
    product: "memhub-windows-desktop-smoke",
    version: resolveBuildVersion(),
    build_number: resolveBuildNumber(),
    git_commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    platform: "win32",
    arch: "x64",
    runner_os: os.type(),
    runner_os_release: os.release(),
    signing: "unsigned",
    phases: [],
    steps: [],
    result: "failed",
  };
  try {
    await runCommand(process.execPath, ["scripts/assert-test-isolation.mjs"], {
      cwd: root,
      env,
    });
    if (options.installer) {
      if (process.env.CI !== "true" || process.env.RUNNER_OS !== "Windows") {
        throw new Error(
          "windows_installer_smoke_requires_disposable_ci_runner",
        );
      }
      const installer = path.resolve(options.installer);
      receipt.installer_sha256 = await sha256File(installer);
      await runCommand(installer, ["/S", "/currentuser", `/D=${installRoot}`], {
        env,
        timeout: 180_000,
        windowsVerbatimArguments: true,
      });
      installed = true;
      executable = path.join(installRoot, "MemHub.exe");
      await waitFor(
        () => exists(executable),
        "windows_nsis_install_failed",
        30_000,
      );
      receipt.installation = "passed";
    }
    if (!executable || !(await lstat(executable)).isFile()) {
      throw new Error("windows_smoke_executable_missing");
    }
    receipt.phases.push(
      await verifyLaunch(
        executable,
        env,
        output,
        "first-launch",
        true,
        receipt.steps,
      ),
    );
    const backup = path.join(
      env.ONE_MEMORY_DATA_DIR,
      "backups/windows-smoke.sqlite3",
    );
    const hash = await sha256File(backup);
    receipt.phases.push(
      await verifyLaunch(
        executable,
        env,
        output,
        "relaunch",
        false,
        receipt.steps,
      ),
    );
    if (
      receipt.phases[0].instance_id === receipt.phases[1].instance_id ||
      (await sha256File(backup)) !== hash
    ) {
      throw new Error(
        "windows_relaunch_did_not_preserve_data_or_replace_runtime",
      );
    }
    receipt.relaunch_data_preserved = "passed";
    if (installed) {
      const names = await readdir(installRoot);
      const uninstallers = names.filter((name) =>
        /^Uninstall.*\.exe$/i.test(name),
      );
      if (uninstallers.length !== 1)
        throw new Error("windows_nsis_uninstaller_missing");
      await runCommand(
        path.join(installRoot, uninstallers[0]),
        ["/S", "/currentuser"],
        {
          env,
          timeout: 180_000,
        },
      );
      await waitFor(
        async () => !(await exists(executable)),
        "windows_nsis_uninstall_failed",
        30_000,
      );
      installed = false;
      if ((await sha256File(backup)) !== hash)
        throw new Error("windows_nsis_uninstall_deleted_data");
      receipt.uninstall_data_preserved = "passed";
    }
    receipt.result = "passed";
    return receipt;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (receipt.result !== "passed") {
      await cp(
        path.join(env.ONE_MEMORY_DATA_DIR, "logs"),
        path.join(output, "logs"),
        {
          recursive: true,
        },
      ).catch(() => {});
    }
    await writeFile(
      path.join(output, "windows-smoke-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    if (!installed)
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 300,
      });
  }
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!["--app", "--installer", "--output"].includes(flag) || !value) {
      throw new Error(
        "usage: smoke-windows-desktop.mjs <--app exe|--installer exe> --output dir",
      );
    }
    options[flag.slice(2)] = value;
  }
  if (!options.output || Boolean(options.app) === Boolean(options.installer)) {
    throw new Error("windows_smoke_arguments_invalid");
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  smokeWindowsDesktop(parseArguments(process.argv.slice(2))).then(
    (receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
        () => process.exit(1),
      );
    },
  );
}
