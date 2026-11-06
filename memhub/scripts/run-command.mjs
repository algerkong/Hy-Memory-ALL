import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export function commandInvocation(
  command,
  args,
  { environment = process.env, platform = process.platform } = {},
) {
  if (command === "pnpm") {
    const entry = environment.npm_execpath;
    if (entry && /\.(?:cjs|mjs|js)$/.test(entry) && existsSync(entry)) {
      return { command: process.execPath, args: [entry, ...args] };
    }
    if (platform === "win32") {
      throw new Error("pnpm_entrypoint_missing: run this script through pnpm");
    }
  }
  return { command, args };
}

export async function runCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args, {
    environment: options.env ?? process.env,
  });
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
    shell: false,
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code ?? signal})`));
    });
  });
}
