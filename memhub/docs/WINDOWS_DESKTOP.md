# Windows 桌面预发布

本分支的 Windows 桌面版本为 `1.0.7-windows.1`（build 45），目标是 Windows 10/11 x64。
这是独立桌面预发布，不是现有 Linux/macOS 完整 Runtime 发行合同的扩展。

## 安装

在 [GitHub Releases](https://github.com/algerkong/Hy-Memory-ALL/releases) 下载
`MemHub-v1.0.7-windows.1-windows-x64-setup.exe`，以及同版本的 `checksums.txt`。
安装包按当前用户安装，不需要管理员权限，自带 Electron、Python Core 和经过哈希校验的
内置向量模型；使用者不需要安装 Node.js、Python 或 uv。

在安装包所在目录校验 SHA-256：

```powershell
Get-FileHash .\MemHub-v1.0.7-windows.1-windows-x64-setup.exe -Algorithm SHA256
```

本预发布没有 Windows Authenticode 签名，Windows SmartScreen 可能显示未知发布者提示。
只有确认下载仓库、版本和校验值都正确后再决定是否安装。

## 运行与数据

- 默认数据目录为 `%USERPROFILE%\.one-memory`，应放在本地 NTFS 文件系统。
- 关闭窗口后留在系统托盘，点击托盘图标可重新打开窗口。
- 通过应用或托盘退出时，停止该桌面实例使用的 Runtime/Core，并清理运行回执。
- 开机启动默认关闭；用户确认开启后，登录时以 `--background` 启动已安装的应用。
- 宿主接入、来源读取与召回授权仍需明确确认；Windows 私有文件使用当前用户 SID/DACL 校验。
- 通过 Windows 应用列表卸载只移除程序，保留记忆数据。更新采用手动下载新安装包。

Windows npm CLI 的受管 Runtime 安装、系统服务、升级与回滚尚未验收，此预发布不支持。
Windows ARM64、网络共享数据目录和 Linux/macOS 的跨平台数据迁移也不在本次验证范围内。

## 开发与打包

原生 Windows x64 环境需要 Node.js 24、pnpm 11.24.0、Python 3.12 和 uv。

```powershell
corepack enable
pnpm install --frozen-lockfile
uv sync --directory apps/core --all-groups --locked
pnpm dev:desktop
```

运行隔离测试时，临时目录必须位于真实用户目录之外。先创建一个可写的本地目录，
例如 `D:\MemHubTests`，然后运行：

```powershell
$env:ONE_MEMORY_TEST_TEMP_ROOT = "D:\MemHubTests"
pnpm test:windows
pnpm package:win:dir
pnpm test:windows:packaged --app build/windows-desktop/win-unpacked/MemHub.exe --output build/windows-desktop/evidence/unpacked
pnpm package:win --prepackaged
```

也可以使用 `pnpm package:win` 从头构建安装包。构建只在原生 Windows x64 上执行，
使用锁定的 Python/Node 依赖以及仓库固定的内置模型，不在 macOS 上交叉打包 Windows Core。

## 验证范围

`Windows desktop` GitHub Actions 使用原生 `windows-latest` x64 runner，依次执行：

1. 类型检查与 Windows SID/DACL、来源文件读取、junction 拒绝、SQLite WAL 快照和进程控制测试。
2. 构建 PyInstaller folder Core、Web 和 Electron unpacked 应用。
3. Playwright 验证真实窗口、截图像素、Core 身份与端口、连接能力、窗口恢复和完整退出。
4. 再次启动，验证 GUI 设置和真实数据库备份保留。
5. 对同一 unpacked 应用制作 NSIS 安装包，在一次性 CI runner 中真实安装、启动和卸载。
6. 校验卸载后数据保留，输出安装包 SHA-256、构建收据和冒烟收据。

Release 附件与 Actions 记录是该具体制品的验证证据。Windows Server runner 的成功不等同于
完成所有 Windows 10/11 实机、任务管理器、真实注销登录或整机重启测试；
`verify-windows-support.mjs` 的完整 CLI/系统服务发行门禁保持未通过状态。
