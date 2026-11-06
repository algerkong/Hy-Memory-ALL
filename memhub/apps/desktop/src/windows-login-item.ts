import type { App } from "electron";
import type { LoginPreference } from "./login-preference";

type LoginApp = Pick<
  App,
  "isPackaged" | "getLoginItemSettings" | "setLoginItemSettings"
>;

export function readWindowsLoginPreference(
  app: LoginApp,
  executablePath: string,
  supported: boolean,
): LoginPreference {
  if (!app.isPackaged || !supported) {
    return { supported: false, enabled: false, status: "unsupported" };
  }
  try {
    const settings = app.getLoginItemSettings({
      path: executablePath,
      args: ["--background"],
    });
    if (
      settings.openAtLogin &&
      settings.executableWillLaunchAtLogin === false
    ) {
      return { supported: false, enabled: false, status: "disabled-by-system" };
    }
    return {
      supported: true,
      enabled: settings.openAtLogin,
      status: settings.openAtLogin ? "enabled" : "disabled",
    };
  } catch {
    return { supported: false, enabled: false, status: "unavailable" };
  }
}

export function setWindowsLoginPreference(
  app: LoginApp,
  executablePath: string,
  input: unknown,
  supported: boolean,
): LoginPreference {
  if (
    !input ||
    typeof input !== "object" ||
    !("openAtLogin" in input) ||
    typeof input.openAtLogin !== "boolean" ||
    !("userConfirmed" in input) ||
    input.userConfirmed !== true
  ) {
    throw new Error("login_preference_confirmation_required");
  }
  if (!app.isPackaged || !supported)
    throw new Error("login_preference_unsupported");
  app.setLoginItemSettings({
    path: executablePath,
    args: ["--background"],
    openAtLogin: input.openAtLogin,
  });
  return readWindowsLoginPreference(app, executablePath, supported);
}
