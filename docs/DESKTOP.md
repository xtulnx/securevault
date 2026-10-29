# SecureVault 桌面版

桌面版使用 Tauri 2 承载现有工作台，并随安装包分发 Rust 服务。桌面程序启动服务、确认就绪后加载同源页面；退出时停止服务并释放数据目录锁。服务启动时保持封印，从界面输入主密码。现有 Web、CLI、httpyac 和 Raycast 接口继续使用原有协议。

## 构建和运行

macOS 最低版本设为 13.3，以覆盖现有页面使用的 WebKit 功能。当前已在 Apple Silicon 本机通过真实 WebView 冒烟检查。

预览包默认使用 ad-hoc 本地签名，并在构建后验证完整应用包及随附服务的签名。它没有 Apple 开发者身份或公证，不能当作已公证的公开分发版本。

需要现有 Rust/C/Perl 构建环境、Node.js/npm、Python 3.11 或更新版本，以及对应平台的 [Tauri 构建依赖](https://v2.tauri.app/start/prerequisites/)。首次安装前端工具：

```sh
npm ci
make desktop
# 使用指定目录和端口：
make desktop ARGS='--data-dir /absolute/path/to/vault-data --port 4174'
# 构建本机安装包：macOS 默认 .app，Linux 默认 .deb。
make desktop-package
# macOS 额外生成 DMG：
python3 scripts/desktop.py build --bundles app,dmg
```

脚本先构建嵌入完整前端的 release 服务，再按目标架构复制到 `desktop/binaries/`，最后运行 Tauri。终端工作目录不影响资源加载。开发模式也使用 release 服务，修改页面或后端后重新执行 `make desktop`。命令参数通过 `--` 传递，例如 `npm run desktop:dev -- -- --port 4174`。

macOS `.app` 位于 `desktop/target/<target>/release/bundle/macos/SecureVault.app`。它包含桌面主程序与随附服务，移动或安装时应保留整个 `.app`。Windows 构建仍受现有后端编译问题限制，不代表已经获得 Windows 支持；Linux、Intel Mac 需要各自机器验证。首版不自动上传 GitHub Release，不包含自动更新。公开分发 macOS 应用还需要开发者签名和公证。

## 数据与已有服务

应用标识为 `org.nx.securevault`，发布者/公司名为 `org.nx`。新安装默认使用系统应用数据目录；macOS 为 `~/Library/Application Support/org.nx.securevault`。菜单 **SecureVault → 服务与数据目录** 显示实际位置与服务地址。现有项目 `data/` 不会被自动扫描或迁移。

升级兼容：没有命令行参数、环境变量或已保存选择时，如果旧版 `com.securevault.desktop` 数据目录存在，会继续直接使用该目录，不复制、移动或删除其中的数据。标识变更后若需要使用其他已有保险库，可以从界面选择。升级前请退出旧版应用，避免两个不同标识的应用同时运行。

封印/初始化页面提供 **打开已有保险库…** 和 **数据目录…**；解锁后的顶栏也有 **数据目录…**。原生菜单另提供 **打开已有保险库…**（Cmd/Ctrl+O）和 **切换数据目录…**：

- 打开已有保险库：选择包含 `vault/` 的数据目录，也可直接选择其中的 `vault/` 文件夹。要求元数据和数据库同时存在，不会将缺损目录当成新保险库初始化。
- 切换数据目录：可选择已有保险库或空文件夹。新目录需自行设置主密码；原有保险库、主密码和数据仍留在原处。此功能不迁移数据。
- 切换前显示目标路径及保留数据说明，有未保存修改时明确提示。取消选择或确认会保留当前会话和草稿。目标被其他服务占用时拒绝切换，当前会话继续可用。
- 切换成功后重新加载封印页面，并原子保存目录选择；设置写入或服务启动失败时尝试恢复原目录。发生服务重启后需要重新解锁。启动时若上次目录不可用，会显示重新选择入口，不会悄悄改用空目录。

启动目录优先级：**`--data-dir` > `SECUREVAULT_DATA_DIR` > 上次界面选择 > 旧版应用目录 > 新版系统应用数据目录**。命令行和环境变量仅覆盖本次启动，不修改已保存选择；它们持续存在时，下次启动仍会覆盖界面选择。相对路径按启动时工作目录解析，建议使用绝对路径。macOS 从 Finder 启动通常不继承终端环境变量，可直接使用界面选择，或从终端启动应用内的可执行文件：

```sh
SECUREVAULT_DATA_DIR=/absolute/path/to/existing-data \
  /path/to/SecureVault.app/Contents/MacOS/securevault-desktop
# 一次性显式指定：
open /path/to/SecureVault.app --args --data-dir /absolute/path/to/existing-data
```

目录选择设置保存在系统应用配置目录下的 `org.nx.securevault/desktop/settings.json`，只记录路径，不保存密码。macOS 对应 `~/Library/Application Support/org.nx.securevault/desktop/settings.json`。

桌面程序默认优先监听 `127.0.0.1:4173`，默认端口被占用时自动使用系统分配的空闲端口，桌面界面连接实际地址。可用 `--port` 显式指定端口（被占用时仍报错），或用 `--port 0` 始终自动分配。实际地址可在菜单 **服务与数据目录** 查看，Raycast/httpyac 需使用该地址。界面切换目录时保留本次服务端口。目录被占用或其他启动错误仍会拒绝启动，不会自动连接其他服务。启动后再次打开应用会唤起原窗口，第二次启动的目录/端口参数不会切换当前保险库，请使用界面入口。

Raycast 和 httpyac 可使用菜单显示的地址；关闭桌面应用后它们无法访问此服务。浏览器和桌面 WebView 不共享管理 Cookie，分别解锁会轮换管理会话，这是现有单管理会话机制的行为。桌面版不读取 `SECUREVAULT_PASSWORD` 来自动解锁，也不继承反向代理来源配置。

## 桌面行为

- 菜单 **SecureVault → 关于 SecureVault…** 显示当前安装版本、平台架构、发布者及应用标识，不需要解锁保险库。版本读取自构建时的 Cargo 包信息，与构建脚本校验的服务端及安装包版本保持一致。
- 未解锁页面底部和解锁后的工作台左上角直接显示当前桌面版本，和“关于”窗口使用同一构建版本；无需解锁或请求服务接口即可显示。
- “关于”窗口的 **打开 GitHub 仓库** 按钮或菜单 **GitHub 项目主页** 会通过系统浏览器打开 [xtulnx/securevault](https://github.com/xtulnx/securevault)。终端可用 `securevault-desktop --version`（或 `-V`）查看版本和项目仓库，不启动本地服务。
- 关闭窗口或 Cmd/Ctrl+Q 退出程序，同时关闭本机服务；首版无托盘常驻。
- 编辑草稿、导入、模型发布和导出未结束时，退出前显示原生确认。页面未响应时提供确认退出的后备入口。
- Cmd/Ctrl+Shift+L 手动封印，空闲和最长会话限制沿用现有规则。尚未加入系统锁屏事件触发的即时封印。
- 复制通过原生剪贴板完成。导出使用原生保存对话框，取消保存不显示成功；单次桌面导出限制 64 MiB，更大文件可通过浏览器下载。
- 外部 HTTP/HTTPS 链接交给系统浏览器；禁止在主窗口导航到外站，也不允许任意协议打开程序。
- 备份、恢复和完整密钥轮换仍使用已有离线 CLI，先退出桌面应用再操作。

## 权限与生命周期

`--desktop-stdio` 是随附服务的内部启动选项：stdout 首行输出协议版本和实际监听地址，stdin 管道关闭后优雅停服，最多等待 5 秒。即使桌面进程异常结束，管道 EOF 也会关闭服务。普通 CLI 启动不依赖 stdin 生命周期。

页面、API、Cookie 和 Origin 均来自同一个回环地址。Tauri 在得到服务实际端口后，才给 `main` 窗口的精确来源授权保存、复制、目录显示/选择和退出反馈命令；没有开放通用 shell、文件系统、窗口创建或插件调用。保存及数据目录路径由原生文件对话框选择，网页不能指定任意数据目录路径。HTTP 防护、权限检查和 CSP 保留，桌面模式的 CSP 只额外允许 Tauri IPC 所需的连接来源。

## 验证

```sh
npm test
make test
make desktop-test
python3 scripts/smoke_desktop.py --binary desktop/binaries/securevault-aarch64-apple-darwin
# 有图形登录会话的 macOS 上，用 debug 桌面程序运行真实 WebView 检查：
TAURI_CONFIG='{"identifier":"org.nx.securevault.smoke"}' \
  cargo build --locked --manifest-path desktop/Cargo.toml
python3 scripts/smoke_desktop.py \
  --binary desktop/binaries/securevault-aarch64-apple-darwin \
  --desktop desktop/target/debug/securevault-desktop
```

按实际平台替换二进制 target 后缀。脚本只使用项目 `samples/.build/` 下的临时目录，检查就绪协议、随机端口、嵌入资源、Cookie、跨来源拒绝、目录独占、父进程管道关闭、重启封印、端口冲突和启动密码拒绝。原生测试覆盖目录优先级、旧标识兼容、缺损目录拒绝、目标被占用、设置写入失败回滚及数据保留；运行前需要 `python3 scripts/desktop.py prepare` 准备随附服务。可选 WebView 检查打开真实窗口，验证初始化、解锁、受保护接口、编辑状态、两个保险库来回切换、目录设置、原数据可读、封印及退出清理；原生文件选择/确认对话框的交互和各平台视觉效果仍需手工验收。冒烟接口仅在 debug 且显式传入测试选项时授权，必须使用尚不存在的独立数据目录，测试设置也写入临时目录。

上面的 debug 构建使用独立测试应用标识，避免已运行的正式应用通过单实例机制拦截测试；测试还会占住默认端口（若已被占用则保留现状），检查自动切换端口后的真实界面。不要关闭日常保险库来运行此检查。

`.github/workflows/desktop.yml` 提供手动 macOS 构建与检查，产物仅保存为 Actions artifact，不发布 Release。

安装包还可通过 `--packaged-desktop /path/to/SecureVault.app/Contents/MacOS/securevault-desktop` 验证随附服务、重复启动和父进程崩溃清理；这个检查同样只使用临时保险库。
