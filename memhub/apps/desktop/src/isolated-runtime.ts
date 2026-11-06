import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const RESERVED_TEST_PORTS = new Set([8765, 18765]);

export interface DesktopTestIsolation {
  home: string;
  userData: string;
}

/** Keep a formal packaged App test off the signed-in user's home and ports.
 *
 * Electron does not promise that changing the shell HOME changes
 * `app.getPath("home")`. Resolve and validate the override against Electron's
 * original home before the single-instance lock, then let the ordinary formal
 * install path create its managed runtime under this temporary home.
 */
export function resolveDesktopTestIsolation(
  environment: NodeJS.ProcessEnv,
  electronHome: string,
  platform: NodeJS.Platform = process.platform,
): DesktopTestIsolation | null {
  const requestedHome = environment.ONE_MEMORY_DESKTOP_TEST_HOME;
  if (requestedHome === undefined) return null;
  if (environment.ONE_MEMORY_TEST_ISOLATED !== "1") {
    throw new Error("desktop_test_isolation_not_armed");
  }
  const realHome = environment.ONE_MEMORY_TEST_REAL_HOME;
  const home = requestedHome;
  const dataDir = environment.ONE_MEMORY_DATA_DIR;
  const hostHome = environment.ONE_MEMORY_HOST_HOME;
  if (!realHome || !home || !dataDir || !hostHome) {
    throw new Error("desktop_test_isolation_paths_missing");
  }
  const normalizedReal = safeAbsolute(realHome, platform);
  const normalizedElectron = safeAbsolute(electronHome, platform);
  const normalizedHome = safeAbsolute(home, platform);
  const normalizedData = safeAbsolute(dataDir, platform);
  const normalizedHost = safeAbsolute(hostHome, platform);
  if (
    !samePath(normalizedElectron, normalizedReal, platform) &&
    !samePath(normalizedElectron, normalizedHome, platform)
  ) {
    throw new Error("desktop_test_real_home_mismatch");
  }
  if (
    inside(normalizedHome, normalizedReal, platform) ||
    inside(normalizedData, normalizedReal, platform) ||
    inside(normalizedHost, normalizedReal, platform)
  ) {
    throw new Error("desktop_test_real_home_refused");
  }
  for (const key of [
    "ONE_MEMORY_CORE_PORT",
    "ONE_MEMORY_RUNTIME_PORT",
    "ONE_MEMORY_BROKER_PORT",
  ] as const) {
    const port = Number(environment[key]);
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      RESERVED_TEST_PORTS.has(port)
    ) {
      throw new Error("desktop_test_port_refused");
    }
  }
  return {
    home: normalizedHome,
    userData:
      platform === "win32"
        ? path.win32.join(normalizedHome, "AppData", "Roaming", "MemHub Test")
        : path.join(
            normalizedHome,
            "Library",
            "Application Support",
            "MemHub Test",
          ),
  };
}

function safeAbsolute(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? path.win32 : path;
  if (!paths.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error("desktop_test_isolation_path_invalid");
  }
  const normalized = paths.normalize(value);
  return existsSync(normalized) ? realpathSync.native(normalized) : normalized;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function inside(
  candidate: string,
  parent: string,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === "win32" ? path.win32 : path;
  const relative = paths.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative))
  );
}

/**
 * An isolated hour can only be opted into by the release entry script; a
 * stale or guessed package name is not enough to change the install root.
 */
export function isIsolatedHourlyDesktop(
  instanceId: unknown,
  packageId: unknown,
): boolean {
  return (
    typeof instanceId === "string" &&
    instanceId.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      instanceId,
    ) &&
    typeof packageId === "string" &&
    packageId.startsWith("One-Memory-H") &&
    packageId.endsWith("-c7-isolated")
  );
}

export function createHourlyPackageId(shortSha: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(shortSha)) throw Error("invalid_short_sha");
  return `One-Memory-H08-${shortSha}-c7-isolated`;
}

export function hourlyRuntimeInstanceId(): string {
  return randomUUID();
}

/**
 * The monotonic anti-downgrade `build_number` a packaged App must hand to
 * `installPackagedRuntime`.
 *
 * `build_number` is the only ordering authority the installer compares, so a
 * package that omits it defaults to 0 and can never outrank an earlier install:
 * R->R.1 would be refused as a downgrade. The value is baked into the bundle's
 * `LSEnvironment` at pack time (`apps/desktop/scripts/after-pack.cjs`) and is
 * also compiled from the canonical root release contract. This reader accepts
 * either source so Finder launches still carry ordering even when an external
 * packaging pipeline omitted the plist field.
 */
export function resolvePackagedBuildNumber(
  environmentValue: unknown,
  embeddedValue?: unknown,
): number | undefined {
  for (const value of [environmentValue, embeddedValue]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/**
 * The packaged-runtime install, local install, release download and release
 * scripts all require a full 40-character lowercase commit. Normalise here so
 * that one format crosses this boundary: an uppercase full SHA is lowercased,
 * and a short or malformed value is skipped so it cannot shadow the next source.
 */
export function resolvePackagedCommit(
  environmentValue: unknown,
  embeddedValue?: unknown,
): string | undefined {
  for (const value of [environmentValue, embeddedValue]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
  }
  return undefined;
}

export function isCanonicalDailyDataDir(
  home: string,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? path.win32 : path;
  return samePath(
    safeAbsolute(dataDir, platform),
    paths.join(safeAbsolute(home, platform), ".one-memory"),
    platform,
  );
}
