import assert from "node:assert/strict";
import test from "node:test";
import { windowsIsolationEnvironment } from "./run-tests-isolated.mjs";

const options = {
  runRoot: "D:\\tests\\memory with spaces",
  realHome: "C:\\Users\\Real",
  corePort: 28785,
  brokerPort: 28786,
  environment: { npm_execpath: "C:\\tools\\pnpm.cjs" },
};

test("Windows tests redirect both shell and native profile paths", () => {
  const env = windowsIsolationEnvironment(options);
  assert.equal(env.HOME, "D:\\tests\\memory with spaces\\home");
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.ONE_MEMORY_HOST_HOME, env.HOME);
  assert.equal(env.HOMEDRIVE, "D:");
  assert.equal(env.HOMEPATH, "\\tests\\memory with spaces\\home");
  assert.equal(env.APPDATA, `${env.HOME}\\AppData\\Roaming`);
  assert.equal(env.LOCALAPPDATA, `${env.HOME}\\AppData\\Local`);
  assert.equal(env.TEMP, "D:\\tests\\memory with spaces\\tmp");
  assert.equal(env.npm_execpath, options.environment.npm_execpath);
  assert.equal(env.ONE_MEMORY_TEST_ISOLATED, "1");
});

test("Windows isolation refuses real-profile aliases and daily ports", () => {
  for (const runRoot of [
    options.realHome,
    "c:\\USERS\\real\\Temp",
    "C:\\Users\\Real\\..\\Real\\Temp",
  ]) {
    assert.throws(
      () => windowsIsolationEnvironment({ ...options, runRoot }),
      /test_temp_root_unsafe/,
    );
  }
  for (const corePort of [8765, 18765, 80, 65536, Number.NaN]) {
    assert.throws(
      () => windowsIsolationEnvironment({ ...options, corePort }),
      /test_port_unsafe/,
    );
  }
  assert.throws(
    () =>
      windowsIsolationEnvironment({ ...options, brokerPort: options.corePort }),
    /test_ports_must_differ/,
  );
});
