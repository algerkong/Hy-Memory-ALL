import concurrently from "concurrently";
import { runCommand } from "./run-command.mjs";

const mode = process.argv[2];

try {
  if (mode === "core") {
    await runCommand("uv", ["run", "--directory", "apps/core", "one-memory"], {
      env: {
        ...process.env,
        ONE_MEMORY_API_TOKEN: "one-memory-dev-token",
      },
    });
  } else if (mode === "web" || mode === "desktop") {
    const commands =
      mode === "web"
        ? [
            { name: "core", command: "pnpm dev:core" },
            {
              name: "web",
              command: "pnpm --filter @one-memory/web dev",
              env: { VITE_CORE_API_TOKEN: "one-memory-dev-token" },
            },
          ]
        : [
            { name: "web", command: "pnpm --filter @one-memory/web dev" },
            {
              name: "desktop",
              command:
                "wait-on http://127.0.0.1:5173 && pnpm --filter @one-memory/desktop dev",
            },
          ];
    await concurrently(commands, {
      killOthersOn: ["failure", "success"],
      successCondition: mode === "desktop" ? "command-desktop" : "all",
    }).result;
  } else {
    throw new Error("usage: dev.mjs <core|web|desktop>");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
