# SecureVault

Rust 服务端与静态 Web 界面的本地保险库。

## 功能与演示

SecureVault 将不同业务的数据集集中管理，按目录和标签检索，字段可设为索引、展示、普通、隐藏加密、敏感或忽略。数据库使用 SQLCipher 加密，受保护字段另用 AES-256-GCM 加密；敏感字段按需查看，界面明文展示 30 秒后恢复掩码。

- **检索与展示**：支持空格 AND、字段精确匹配、前缀、后缀和正则；目录筛选包含子目录，标签可多选并取交集，过期记录默认隐藏；手机分类面板支持多选目录，应用后返回检索，多个目录取并集并包含子目录。记录标识可按数据集选择公开字段或复合字段，没有名称时回退逻辑 KEY 或系统 ID；实际命中字段优先展示并高亮片段；单数据集范围省略条目中的重复来源，列表不显示更新时间。摘要隐藏无值字段，保留 0 和 false，并按实际可用宽度调整展示数量；详情打开和关闭时自动重排。列表支持字段顺序、可见性及单行、多行、JSON 格式、共享默认与临时密度。
- **导入与更新**：支持 JSON、CSV、XLSX，源字段映射、JSON 路径抽取和保存模板；逻辑唯一 KEY 可组合多个字段，重复项默认更新，也可跳过，完整批次支持删除缺失项。
- **数据模型与多标签**：同类数据集引用一套主表/附表结构、逻辑 KEY 和默认展示配置，可在模型说明中记录共用提取方法与 SQL；客户、环境等分类统一用多个标签表达，筛选按标签交集匹配；标签支持引用已有项或输入新名称并随数据集保存自动创建。数据集实例分别保存记录、导入模板和应用授权。旧库在带密码启动或首次解锁时自动升级，保留数据集/记录 ID、密文和原有授权，每个旧数据集先获得独立模型，可手动预览并合并到数据模型。结构修改经预览后统一发布，失败整体回滚。见 [数据模型与运行时升级](docs/SHARED_SCHEMAS.md)。
- **数据集管理与下载**：管理、编辑和导入在主窗口操作，单个数据集默认展示只读信息，字段、列表和基本信息分别主动修改；导出支持仅结构、仅数据、结构与数据，默认不包含机密数据。XLSX 将字段值作为文本保存，保留前导零和长编号。
- **数据集描述**：每个数据集可保存多行 Markdown 长文本，默认紧凑只读，点击“修改描述”才打开独立编辑器；支持标题、列表、表格和 SQL 等代码块。描述原文随加密数据库和逻辑备份保存。
- **检索页数据集入口**：选择具体数据集后可通过图标查看说明与字段定义，管理会话可直接编辑或导入；同目录有多个数据集时可按数据集和多个标签选择。
- **普通与忽略字段**：普通字段不参与检索或列表展示，仅在详情中展示，并包含在常规导出中；忽略字段保留 Schema 规则，导入值不写入数据库，不能作为逻辑 KEY。将已有字段改为忽略会清除原值。
- **主表与附表**：主表支持手工新增、编辑和删除记录，后续批量导入仍可更新主表。每个数据集有一个独立附表，可自定义普通、敏感等字段，与主表记录一对一关联；主表导入不会覆盖附表。数据集管理页和检索页的附表入口支持字段管理、查看、编辑、重新关联、删除和批量清理失联记录，主记录详情支持直接新增或编辑附表。附表的索引和展示字段参与组合搜索，可用 `supplement.字段名:` 或 `附表.字段名:` 单独过滤附表；普通、敏感和隐藏字段不参与搜索。
- **附表关联**：优先使用全部属于索引区域的逻辑 KEY，未满足条件时使用所有索引字段组合；没有索引字段时使用主表系统 ID。现存主记录的索引、字段名或 KEY 变化时，整个附表跟随更新；主记录删除后附表保留，重导入相同索引且唯一匹配时恢复关联。重复、不完整或无法从失联主记录取得新索引值时，不自动猜测关联，可手工重新选择主记录或清理。旧版重复关联的多余记录保留为失联记录，不自动删除。
- **移动端**：顶部锁定和会话控制区随页面滚动保持可见；手机端重新排列搜索、操作按钮、字段和弹窗，支持触控操作。
- **检索排序**：分页前按匹配度排序，完整值优先于完整词段、前后缀和局部包含；多关键词兼顾完整短语及同字段集中命中，同等匹配优先公开逻辑 KEY 和记录标识。目录等显式筛选不加分；命中字段也按相关程度前置。匹配与评分合并，使用有界候选堆获得与全排序一致的分页，保留准确总数。见 [检索排序规则](docs/SEARCH_RULES.txt)及 [性能验证](docs/SEARCH_PERFORMANCE.txt)。
- **应用接入**：应用可分别设置只搜索或敏感字段权限，指定可访问数据集，设置授权时效，并支持停用和密钥轮换。
- **httpyac 按需取值**：提供可复用的 MJS 脚本，在请求执行前按数据集 ID 或名称、多个标签和模型定位唯一记录，读取主表、附表及获授权的敏感字段，并映射为请求变量。脚本、示例和配置见 [httpyac 接入说明](extensions/httpyac/README.md)。
- **Raycast 查询入口**：独立扩展支持主表与附表联合搜索、目录/多标签/模型/数据集筛选、非敏感详情及字段复制；需要敏感信息时一键打开网页中的对应记录，锁定时解锁后继续定位。安装与配置见 [Raycast 扩展说明](extensions/raycast/README.md)。
- **结构迁移**：Schema 文件保留字段区域、逻辑 KEY、列表规则、记录标识、Markdown 描述及附表定义；原生数据集包还可包含主表、附表和模板。导入先预览，确认后事务提交，结构差异与模板重名有明确提示。见 [数据集交换格式](docs/DATASET_FORMAT.txt)。
- **统一工作台**：检索、数据集、接入应用采用统一导航，支持浅色与深色；宽屏并排阅读记录详情，窄屏使用弹层。Cmd/Ctrl+K 定位检索，结果支持方向键与 Enter。
- **应用管理与授权**：按名称、ID 和状态筛选应用，独立查看授权数据集及到期时间；创建时一次选择访问级别、范围和期限，密钥仅显示一次。编辑授权默认保留原到期时间，支持搜索数据集、批量选择匹配项和只看已选；到期或停用应用可明确重新授权并启用。
- **单文件发布**：release 二进制嵌入前端资源；开发模式直接读取 `web/`，无需为页面修改重新编译。

以下为当前版本的实际界面截图，使用独立初始化的虚构演示数据，包含游戏产品、支付商户、云服务、Webhook、运行手册和平台配置，共 **8 个数据集、98 条记录、308 个加密字段**。其中 4 条记录过期，默认检索显示 94 条。截图不包含主密码或密钥明文。

![检索工作台与分类目录](docs/screenshots/overview.webp)

<details>
<summary>字段检索与多环境结果</summary>

输入 `category:=游戏业务 gid:=2001 platform:=Android`，可同时查询正式、测试和预发布环境中的同一产品，匹配字段优先展示。正式环境的 SDK 版本已通过复合 KEY 更新为 `3.3.1`。

![字段检索与命中高亮](docs/screenshots/search.webp)

</details>

<details>
<summary>记录详情与敏感字段掩码</summary>

宽屏在右侧查看记录详情，窄屏使用弹层。概览和敏感字段分别展示；点击“按需查看”可临时查看敏感字段，30 秒后恢复掩码，隐藏字段仅加密存储。

![记录详情与检索并排展示](docs/screenshots/detail.webp)

![敏感字段默认掩码](docs/screenshots/secrets.webp)

</details>

<details>
<summary>数据集管理、只读信息与结构导出</summary>

数据集基本信息支持可选名称，未填写时显示目录末级名称，名称与目录、标签及数据模型分别维护。管理页把目录和数据模型分列，展示标签、记录数、字段数和逻辑 KEY；标题和记录数可直接进入记录，常用操作展开显示。“查看信息”展示只读描述与字段定义；描述紧凑展示，修改时再进入编辑。基本信息与导入页展示引用的数据模型及取数说明，详情可在只读弹窗中查看，保留当前编辑和导入配置。导出支持仅结构、仅数据、结构与数据；仅结构包含字段用途、逻辑 KEY、描述、展示配置及附表定义，不包含记录值。

![数据集管理列表](docs/screenshots/datasets.webp)

![数据集只读信息](docs/screenshots/dataset-info.webp)

![仅结构导出配置](docs/screenshots/export.webp)

</details>

<details>
<summary>导入工作台与 JSON 路径抽取</summary>

导入分为选择文件、配置、确认三个步骤，提交前检查字段映射、JSON 路径和重复处理策略。截图展示 Webhook 文件的保存模板及 `config.endpoint` 抽取。

![导入映射与模板](docs/screenshots/import.webp)

</details>

<details>
<summary>应用状态与数据集授权</summary>

演示包含只读检索、支付验签、已停用和已过期四种应用。只读机器人仅授权正式游戏和运行手册，可检索但不可解密；授权抽屉集中设置访问级别、时效和可见数据集。

![应用权限与有效期状态](docs/screenshots/apps.webp)

![应用可访问数据集配置](docs/screenshots/authorization.webp)

</details>

<details>
<summary>深色界面</summary>

检索、导航和详情支持浅色与深色主题。

![深色检索与命中高亮](docs/screenshots/dark.webp)

</details>

<details>
<summary>手机端检索与目录多选</summary>

手机端保留顶部封印按钮和底部导航，摘要随可用宽度调整。分类目录在独立面板中多选，父目录包含子目录，点击“应用筛选”返回检索。

![手机端检索与顶部控制区](docs/screenshots/mobile.webp)

![手机端分类目录多选](docs/screenshots/mobile-directory.webp)

</details>

## 一键体验

安装下方构建依赖及 Python 3 后，在项目根目录执行：

```sh
make demo                 # 构建并初始化独立演示库，使用随机主密码
make demo-serve           # 重启已有演示库，需在页面输入主密码解锁
python3 samples/scripts/api_demo.py  # 验证应用检索范围与解密权限
```

演示地址为 `http://127.0.0.1:4180/`，可通过 `DEMO_PORT` 覆盖。随机密码、加密数据库、应用密钥、导入及验证报告保存在已被 Git 忽略的 `samples/.runtime/`；原有 `data/` 不会被访问或覆盖。初始化脚本通过 HTTP API 实际导入原始文件，完成 18 组功能检查，已有演示库时拒绝覆盖。

详细数据集说明、原始文件、检索例子、停止及重新初始化方法见 [演示说明](samples/README.md)。所有示例密钥以 `DEMO_ONLY_` 开头，域名使用 `example.test`，不依赖真实外部服务。

## 构建与运行

需要 Rust stable（支持 edition 2024）、C/C++ 编译工具及 Perl；SQLCipher 与 OpenSSL 从源码构建。使用 `make` 命令需要 Make，打包还需要 Python 3。当前发布支持下表中的 Linux 和 macOS 平台。

```sh
make             # 编译 release 二进制
make check       # 检查代码
make test        # 运行测试
make test-web    # 前端回归测试（首次运行前执行 npm ci）
make run         # 从源码运行
make run ARGS='--port 8080'
make package     # 生成 dist/securevault-<版本>-<平台>.tar.gz
make clean       # 清理构建产物和 dist
```

默认构建本机平台，可通过 `make package TARGET=x86_64-unknown-linux-gnu` 指定下表中的 Rust target（须自行安装对应工具链与链接器）。Makefile 使用已提交的 `server/Cargo.lock` 固定依赖版本。

发布包仅包含 `securevault` 单个二进制，HTML、CSS、JavaScript 及其他 `web/` 资源在构建时自动嵌入，无需额外分发前端目录。解压后执行 `./securevault`，访问 `http://127.0.0.1:4173`，默认将数据写入二进制同目录的 `data/`。`make run` / debug 构建仍直接读取项目的 `web/`，便于修改前端后刷新调试；release 构建始终使用嵌入资源，更新前端后需要重新构建并替换二进制。构建脚本会监测 `web/` 的文件变化及新增、删除，自动重新生成嵌入资源。可用 `-d, --data-dir PATH`、`-p, --port PORT`、`-a, --addr HOST:PORT` 覆盖默认设置，或使用 `SECUREVAULT_DATA_DIR`、`SECUREVAULT_ADDR` 环境变量。

Windows 连续三次构建未通过，已停止自动构建和打包，不提供 Windows 发布包。源码中的适配保留，但尚未通过发布验证。后续研究可参考 [Rust MSVC 平台要求](https://doc.rust-lang.org/stable/rustc/platform-support/windows-msvc.html)、[Rust 静态运行库说明](https://doc.rust-lang.org/reference/linkage.html#static-and-dynamic-c-runtimes)、[OpenSSL Windows 汇编构建说明](https://github.com/alexcrichton/openssl-src-rs#windows-msvc-assembly) 和 [NASM 安装 Action](https://github.com/ilammy/setup-nasm)。

CLI 支持长短参数名称，长名称保持兼容：

| 参数 | 短名称 | 适用命令 |
| --- | --- | --- |
| `--data-dir` | `-d` | 启动、backup、rotate-keys |
| `--port` | `-p` | 启动 |
| `--addr` | `-a` | 启动 |
| `--input` | `-i` | restore |
| `--output` / `--output-dir` | `-o` | backup / restore、rotate-keys |
| `--password-stdin` / `--passwords-stdin` | `-s` | 启动 / 管理命令 |
| `--password` | `-P` | 启动（会暴露于进程参数，优先使用 `-s`） |
| `--help` | `-h` | 所有命令 |

## 全量备份与恢复

停服后可导出独立密码保护的 `.jsonl.gz.age` 逻辑备份，包含全部业务数据、敏感/隐藏字段、数据集配置、模板及审计。恢复到新目录并设置新主密码，生成新数据密钥、撤销旧应用凭据。备份格式独立于数据库结构，可通过标准 age 解密、gzip 解压得到公开 JSONL，无需 SecureVault 读取明文。

```sh
./securevault backup -d ./data -o ./backup.jsonl.gz.age
./securevault restore -i ./backup.jsonl.gz.age -o ./restored-data
```

密码默认从终端隐藏输入，备份密码独立于主密码。格式、兼容规则、标准工具解密、sample 操作与验证见 [备份恢复说明](docs/BACKUP_FORMAT.md)。

## 安全与访问控制

浏览器解锁后通过 HttpOnly 会话访问管理功能；每次解锁最多持续 6 小时，连续 30 分钟无真实前端操作自动封印，最后 10 分钟显示锁定原因与倒计时。键盘、鼠标、滚动和触控操作会保持活跃，API 调用和后台轮询不会续期，多标签页共享会话计时。应用密钥仅允许授权数据集的检索、查看与导出，不能管理数据集或应用。HTTP 服务仅允许监听回环地址，远程使用须配置 HTTPS 反向代理及 `SECUREVAULT_PUBLIC_ORIGIN`。数据使用独立随机密钥，主密码通过 Argon2id 保护密钥封装；可在“安全设置”更换主密码，成功后撤销全部管理会话并封印。管理员还可停服运行 `./securevault rotate-keys --data-dir ./data --output-dir ./data-rotated`，完整轮换三把数据密钥；默认隐藏输入密码，生成新库，保留原库，并撤销旧应用凭据。成功后需切换服务的数据目录并重新签发应用凭据。这是全新数据格式，不兼容旧开发数据库。完整安全边界、部署要求与回归方法见 [安全说明](docs/SECURITY.md)。

```sh
python3 samples/scripts/rotation_check.py  # 验证离线完整密钥轮换
python3 samples/scripts/security_check.py  # 先构建 release；临时数据库验证，不影响已有数据
```

## 自动发布

将 `server/Cargo.toml` 的版本号更新为目标版本；如果依赖或包版本有变化，运行 `cargo check --manifest-path server/Cargo.toml` 更新锁文件，并一并提交。推送前可用 `python3 scripts/release.py version --tag v0.1.0` 检查目标 tag 是否与版本一致。

推送与 Cargo 版本一致的 `v` 标签即可触发 GitHub Actions，例如版本 `0.1.0`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

工作流先检查 tag 与 Cargo 版本是否一致，再在各平台的原生 runner 上运行测试、构建 release、执行二进制 `--help` 检查并打包。每个平台还会用临时数据验证嵌入前端、保险库初始化、更换主密码、备份恢复和完整密钥轮换：

| 平台 | Rust target | GitHub runner | 压缩格式 |
| --- | --- | --- | --- |
| Linux x86_64 | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` | `.tar.gz` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `.tar.gz` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `macos-15` | `.tar.gz` |
| macOS Intel | `x86_64-apple-darwin` | `macos-15-intel` | `.tar.gz` |

runner 标签见 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

四个平台全部成功且附件齐全后才创建 GitHub Release，附带自动生成的版本说明、四个压缩包和覆盖全部压缩包的 `SHA256SUMS`。校验脚本会拒绝缺失平台或额外压缩包，Windows ZIP 不会进入发布。Linux 包使用 glibc，运行环境需兼容 Ubuntu 24.04 的系统库。

含 `-` 的版本标签（如 `v0.2.0-rc.1`）标记为预发布；重跑工作流会更新已有 Release 的附件。也可在 Actions 页面手动运行 Release 工作流，验证全部平台并下载构建附件；手动运行不会创建或修改 GitHub Release。无需额外 Token，发布任务使用仓库的 `GITHUB_TOKEN`。

tag 固定指向创建时的提交；版本不匹配或构建配置修复后，重跑旧 tag 不会使用新代码。当前 Cargo 版本为 `0.1.0` 时，应先提交并推送修复，再在该提交上创建、推送 `v0.1.0`。以后每次发布先同步 Cargo.toml 与 Cargo.lock 的版本，再创建对应的新 tag。
