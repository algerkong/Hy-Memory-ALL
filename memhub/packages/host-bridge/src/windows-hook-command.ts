import path from "node:path";

function literal(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("windows_hook_command_invalid");
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsHookCommand(
  binary: string,
  args: string[],
  mode: "silent" | "context",
  environment: Record<string, string>,
  debugDelivery = false,
): string {
  const assignments = Object.entries(environment)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]+$/.test(key))
        throw new Error("windows_hook_command_invalid");
      return `$env:${key} = ${literal(value)}`;
    })
    .join("\n");
  const invocation = `$payload | & ${literal(binary)} ${args.map(literal).join(" ")}`;
  const run =
    mode === "silent"
      ? `$null = ${invocation} 2>$null`
      : debugDelivery
        ? `$output = @(if ($env:ONE_MEMORY_DEBUG_DELIVERY -eq '1') { ${invocation} } else { ${invocation} 2>$null })`
        : `$output = @(${invocation} 2>$null)`;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
${assignments}
try {
  $payload = [Console]::In.ReadToEnd()
  ${run}
  ${mode === "context" ? "if ($LASTEXITCODE -eq 0) { foreach ($line in $output) { [Console]::WriteLine($line) } }" : ""}
} catch {}
exit 0
`;
  const powershell = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return `"${powershell}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
