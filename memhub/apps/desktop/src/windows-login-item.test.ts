import type { App } from "electron";
import { expect, it, vi } from "vitest";
import {
  readWindowsLoginPreference,
  setWindowsLoginPreference,
} from "./windows-login-item";

function fixture(packaged = true) {
  let enabled = false;
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: enabled,
      executableWillLaunchAtLogin: enabled,
    })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
      enabled = settings.openAtLogin;
    }),
  };
  return app as typeof app &
    Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;
}
const executable =
  "C:\\Users\\Example\\AppData\\Local\\Programs\\MemHub\\MemHub.exe";

it("does not enable startup while reading the preference", () => {
  const app = fixture();
  expect(readWindowsLoginPreference(app, executable, true)).toEqual({
    supported: true,
    enabled: false,
    status: "disabled",
  });
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});

it("registers only the installed executable and background argument with confirmation", () => {
  const app = fixture();
  expect(
    setWindowsLoginPreference(
      app,
      executable,
      { openAtLogin: true, userConfirmed: true },
      true,
    ),
  ).toMatchObject({ enabled: true });
  expect(app.setLoginItemSettings).toHaveBeenCalledWith({
    path: executable,
    args: ["--background"],
    openAtLogin: true,
  });
  expect(
    setWindowsLoginPreference(
      app,
      executable,
      { openAtLogin: false, userConfirmed: true },
      true,
    ),
  ).toMatchObject({ enabled: false });
});

it("refuses unconfirmed changes, development builds and isolated profiles", () => {
  const app = fixture();
  expect(() =>
    setWindowsLoginPreference(app, executable, { openAtLogin: true }, true),
  ).toThrow("confirmation_required");
  expect(() =>
    setWindowsLoginPreference(
      fixture(false),
      executable,
      { openAtLogin: true, userConfirmed: true },
      true,
    ),
  ).toThrow("unsupported");
  expect(() =>
    setWindowsLoginPreference(
      app,
      executable,
      { openAtLogin: true, userConfirmed: true },
      false,
    ),
  ).toThrow("unsupported");
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});

it("reflects Task Manager disabling a registered startup item", () => {
  const app = fixture();
  app.getLoginItemSettings.mockReturnValue({
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
  });
  expect(readWindowsLoginPreference(app, executable, true)).toEqual({
    supported: false,
    enabled: false,
    status: "disabled-by-system",
  });
});
