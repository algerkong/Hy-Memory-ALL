import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export type PrivatePathKind = "directory" | "file";

interface WindowsAclInspection {
  current_sid: string;
  owner_sid: string;
  reparse: boolean;
  current_user_full_control: boolean;
  rules: Array<{ sid: string; allow: boolean; rights: number }>;
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const FULL_CONTROL = 0x1f01ff;

/** SYSTEM and administrators are already outside the OS-account boundary. */
export function assertWindowsPrivateAcl(value: unknown): void {
  const info = value as WindowsAclInspection | null;
  if (
    !info ||
    typeof info !== "object" ||
    typeof info.current_sid !== "string" ||
    !/^S-1-\d+(?:-\d+)+$/.test(info.current_sid) ||
    ![info.current_sid, SYSTEM_SID, ADMINISTRATORS_SID].includes(
      info.owner_sid,
    ) ||
    info.reparse !== false ||
    info.current_user_full_control !== true ||
    !Array.isArray(info.rules) ||
    info.rules.length === 0 ||
    info.rules.some(
      (rule) =>
        !rule ||
        typeof rule !== "object" ||
        typeof rule.sid !== "string" ||
        typeof rule.allow !== "boolean" ||
        !Number.isSafeInteger(rule.rights) ||
        rule.rights < 0 ||
        (!rule.allow && rule.rights !== 0) ||
        (rule.allow &&
          rule.rights !== 0 &&
          ![info.current_sid, SYSTEM_SID, ADMINISTRATORS_SID].includes(
            rule.sid,
          )),
    )
  ) {
    throw new Error("private_storage_unsafe");
  }
}

export function assertPrivateStat(
  info: Stats,
  kind: PrivatePathKind,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): void {
  if (
    info.isSymbolicLink() ||
    (kind === "directory"
      ? !info.isDirectory()
      : !info.isFile() || info.nlink !== 1) ||
    (platform !== "win32" &&
      (uid === undefined ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== (kind === "directory" ? 0o700 : 0o600)))
  ) {
    throw new Error("private_storage_unsafe");
  }
}

/** Windows chmod is not an ACL check. Inspect the actual current-user DACL. */
export async function assertPrivatePath(
  target: string,
  kind: PrivatePathKind,
): Promise<Stats> {
  const before = await lstat(target);
  assertPrivateStat(before, kind);
  if (process.platform === "win32") {
    assertWindowsPrivateAcl(await windowsAcl(target, kind, false));
    const after = await lstat(target);
    assertPrivateStat(after, kind);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("private_storage_changed");
    }
  }
  return before;
}

/** Only use on product-owned paths, never on a host's configuration directory. */
export async function protectWindowsPrivatePath(
  target: string,
  kind: PrivatePathKind,
): Promise<void> {
  if (process.platform !== "win32") return;
  const before = await lstat(target);
  assertPrivateStat(before, kind);
  assertWindowsPrivateAcl(await windowsAcl(target, kind, true));
  const after = await lstat(target);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("private_storage_changed");
  }
}

/** Host configuration may be readable, but never writable by other accounts. */
export async function assertWindowsWritablePath(
  target: string,
  kind: PrivatePathKind,
): Promise<Stats | undefined> {
  if (process.platform !== "win32") return undefined;
  const before = await lstat(target);
  assertPrivateStat(before, kind);
  const value = (await windowsAcl(target, kind, false)) as WindowsAclInspection;
  const writeRights = 0x000d0156;
  assertWindowsPrivateAcl({
    ...value,
    rules: value.rules?.map((rule) => ({
      ...rule,
      rights:
        rule.allow && Number.isSafeInteger(rule.rights) && rule.rights >= 0
          ? rule.rights & writeRights
          : rule.rights,
    })),
  });
  const after = await lstat(target);
  assertPrivateStat(after, kind);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("private_storage_changed");
  }
  return after;
}

export async function syncPrivateDirectory(target: string): Promise<void> {
  if (process.platform === "win32") {
    // Node cannot fsync a Windows directory. Writers flush the file before
    // replacing it; still verify the directory instead of treating chmod as ACL.
    await assertPrivatePath(target, "directory");
    return;
  }
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    assertPrivateStat(await handle.stat(), "directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function windowsAcl(
  target: string,
  kind: PrivatePathKind,
  protect: boolean,
): Promise<unknown> {
  if (
    !path.isAbsolute(target) ||
    /[\0\r\n]/.test(target) ||
    (protect && path.resolve(target) === path.parse(target).root)
  ) {
    throw new Error("private_storage_path_invalid");
  }
  aclWorker ??= createAclWorker();
  return aclWorker.request({
    target,
    directory: kind === "directory",
    protect,
  });
}

// Keep a bounded worker, not cached ACL evidence. Connection setup verifies
// many files; starting PowerShell for each one would exhaust its HTTP deadline.
const ACL_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class MemHubPrivatePaths {
  [StructLayout(LayoutKind.Sequential)]
  public struct AttributeTag { public uint Attributes; public uint Tag; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
    int type, out AttributeTag info, uint size);
  public static List<SafeFileHandle> Pin(string target, bool directory) {
    var paths = new List<string>();
    var parent = new DirectoryInfo(directory ? target : Path.GetDirectoryName(target));
    while (parent != null) { paths.Add(parent.FullName); parent = parent.Parent; }
    paths.Reverse();
    if (!directory) paths.Add(target);
    var handles = new List<SafeFileHandle>();
    try {
      for (int i = 0; i < paths.Count; i++) {
        bool isDirectory = directory || i < paths.Count - 1;
        var handle = CreateFileW(paths[i], 0x20080, 3, IntPtr.Zero, 3,
          0x200000u | (isDirectory ? 0x2000000u : 0u), IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(); }
        handles.Add(handle);
        AttributeTag info;
        if (!GetFileInformationByHandleEx(handle, 9, out info, 8))
          throw new Win32Exception();
        if ((info.Attributes & 0x400) != 0 ||
            ((info.Attributes & 0x10) != 0) != isDirectory)
          throw new IOException("unsafe_path");
      }
      return handles;
    } catch { foreach (var handle in handles) handle.Dispose(); throw; }
  }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  $pins = $null
  $stage = 'request'
  try {
    $request = $line | ConvertFrom-Json
    $target = [string]$request.target
    $directory = [bool]$request.directory
    $stage = 'pin'
    $pins = [MemHubPrivatePaths]::Pin($target, $directory)
    $stage = 'identity'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $stage = 'read'
    $acl = Get-Acl -LiteralPath $target
    $stage = 'owner'
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($sid.Value, '${SYSTEM_SID}', '${ADMINISTRATORS_SID}')) { throw 'owner' }
    if ($request.protect) {
      $stage = 'protect'
      if ($directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
      else { $acl = New-Object System.Security.AccessControl.FileSecurity }
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
      if ($directory) {
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      }
      foreach ($principal in @($sid, (New-Object System.Security.Principal.SecurityIdentifier('${SYSTEM_SID}')))) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $target -AclObject $acl
      $acl = Get-Acl -LiteralPath $target
      $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    }
    $stage = 'verify'
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow');
         rights = [int]$_.FileSystemRights; inherit_only = (($_.PropagationFlags -band 2) -ne 0) }
    })
    $full = @($rules | Where-Object { $_.sid -eq $sid.Value -and $_.allow -and !$_.inherit_only -and (($_.rights -band ${FULL_CONTROL}) -eq ${FULL_CONTROL}) }).Count -gt 0
    $value = @{ current_sid = $sid.Value; owner_sid = $owner; reparse = $false; current_user_full_control = $full; rules = $rules }
    $response = @{ id = $request.id; ok = $true; value = $value }
  } catch {
    $exception = $_.Exception.GetBaseException()
    $response = @{ id = $request.id; ok = $false; error = @{
      stage = $stage; kind = $exception.GetType().Name; code = [int]$exception.HResult
      line = [int]$_.InvocationInfo.ScriptLineNumber
    } }
  }
  finally { if ($null -ne $pins) { foreach ($pin in $pins) { $pin.Dispose() } } }
  [Console]::WriteLine(($response | ConvertTo-Json -Depth 5 -Compress))
}
`;

interface AclRequest {
  target: string;
  directory: boolean;
  protect: boolean;
}
interface AclWorker {
  request(value: AclRequest): Promise<unknown>;
}
let aclWorker: AclWorker | null = null;

function createAclWorker(): AclWorker {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const child = spawn(
    path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(ACL_WORKER_SCRIPT, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 0;
  let output = "";
  let idle: NodeJS.Timeout | undefined;
  let closed = false;
  const reference = (enabled: boolean) => {
    child[enabled ? "ref" : "unref"]();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const pipe = stream as typeof stream & { ref?(): void; unref?(): void };
      pipe[enabled ? "ref" : "unref"]?.();
    }
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    if (aclWorker === worker) aclWorker = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("private_storage_acl_unavailable"));
    }
    pending.clear();
    child.kill();
    reference(false);
  };
  const idleWhenReady = () => {
    if (pending.size !== 0 || closed) return;
    reference(false);
    idle = setTimeout(finish, 2_000);
    idle.unref();
  };
  child.on("error", finish);
  child.on("exit", finish);
  child.stdin.on("error", finish);
  child.stdout.on("error", finish);
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (Buffer.byteLength(output) > 64 * 1024) return finish();
    let newline = output.indexOf("\n");
    while (newline !== -1) {
      const line = output
        .slice(0, newline)
        .replace(/^\uFEFF/, "")
        .trim();
      output = output.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        const request = pending.get(response.id);
        if (!request || typeof response.ok !== "boolean") return finish();
        pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.ok) request.resolve(response.value);
        else {
          const diagnostic = response.error;
          const cause =
            diagnostic &&
            [
              "request",
              "pin",
              "identity",
              "read",
              "owner",
              "protect",
              "verify",
            ].includes(diagnostic.stage) &&
            typeof diagnostic.kind === "string" &&
            /^[A-Za-z]+$/.test(diagnostic.kind) &&
            Number.isSafeInteger(diagnostic.code) &&
            Number.isSafeInteger(diagnostic.line)
              ? new Error(
                  `windows_acl_${diagnostic.stage}:${diagnostic.kind}:${diagnostic.code}:line${diagnostic.line}`,
                )
              : undefined;
          request.reject(
            new Error("private_storage_acl_unavailable", { cause }),
          );
        }
      } catch {
        return finish();
      }
      newline = output.indexOf("\n");
    }
    idleWhenReady();
  });
  const worker: AclWorker = {
    request(value) {
      if (closed || pending.size >= 128) {
        return Promise.reject(new Error("private_storage_acl_unavailable"));
      }
      clearTimeout(idle);
      reference(true);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(finish, 10_000);
        pending.set(id, { resolve, reject, timer });
        // Paths are JSON data on stdin, never interpolated into shell source.
        child.stdin.write(`${JSON.stringify({ id, ...value })}\n`, (error) => {
          if (error) finish();
        });
      });
    },
  };
  idleWhenReady();
  return worker;
}
