import { expect, it } from "vitest";
import {
  isCanonicalDailyDataDir,
  resolveDesktopTestIsolation,
} from "./isolated-runtime";

const environment = {
  ONE_MEMORY_TEST_ISOLATED: "1",
  ONE_MEMORY_TEST_REAL_HOME: "C:\\Users\\Real",
  ONE_MEMORY_DESKTOP_TEST_HOME: "D:\\Tests\\Memory with spaces\\home",
  ONE_MEMORY_DATA_DIR: "D:\\Tests\\Memory with spaces\\home\\.one-memory",
  ONE_MEMORY_HOST_HOME: "D:\\Tests\\Memory with spaces\\home",
  ONE_MEMORY_CORE_PORT: "28785",
  ONE_MEMORY_RUNTIME_PORT: "28785",
  ONE_MEMORY_BROKER_PORT: "28786",
};

it("uses a native Windows userData path and accepts case-insensitive home identity", () => {
  expect(
    resolveDesktopTestIsolation(environment, "c:\\USERS\\real", "win32"),
  ).toEqual({
    home: environment.ONE_MEMORY_DESKTOP_TEST_HOME,
    userData:
      "D:\\Tests\\Memory with spaces\\home\\AppData\\Roaming\\MemHub Test",
  });
  expect(
    isCanonicalDailyDataDir(
      environment.ONE_MEMORY_DESKTOP_TEST_HOME,
      "d:\\tests\\memory WITH spaces\\home\\.one-memory",
      "win32",
    ),
  ).toBe(true);
});

it("refuses Windows real-home descendants even with mixed casing or parent traversal", () => {
  for (const dataDir of [
    "c:\\users\\REAL\\.one-memory",
    "C:\\Users\\Real\\Temp\\..\\.one-memory",
  ]) {
    expect(() =>
      resolveDesktopTestIsolation(
        { ...environment, ONE_MEMORY_DATA_DIR: dataDir },
        "C:\\Users\\Real",
        "win32",
      ),
    ).toThrow("desktop_test_real_home_refused");
  }
});
