# SecureVault

Rust 服务端与静态 Web 界面的本地保险库。

## 功能与演示

SecureVault 将不同业务的数据集集中管理，按目录和标签检索，字段可设为索引、展示、普通、隐藏加密、敏感或忽略。数据库使用 SQLCipher 加密，受保护字段另用 AES-256-GCM 加密；敏感字段按需查看，界面明文展示 30 秒后恢复掩码。

- **检索与展示**：停止输入 500ms 后自动检索，Enter 立即执行，支持中文输入法；未完成或非法条件暂停检索、保留上次结果，不静默忽略条件扩大范围，也不反复弹提示。支持空格 AND、字段精确匹配、前缀、后缀和正则，数组索引按任一元素匹配；目录筛选包含子目录，标签可多选并取交集，过期记录默认隐藏；手机分类面板支持多选目录，应用后返回检索，多个目录取并集并包含子目录。记录标识可按数据集选择公开字段或复合字段，没有名称时回退逻辑 KEY 或系统 ID；实际命中字段优先展示并高亮片段；单数据集范围省略条目中的重复来源，列表不显示更新时间。摘要隐藏无值字段，保留 0 和 false，并按实际可用宽度调整展示数量；详情打开和关闭时自动重排。列表支持字段顺序、可见性及单行、多行、JSON 格式、共享默认与临时密度。
- **导入与更新**：支持 JSON、JSONL、CSV、XLSX、YAML（.yaml / .yml）、TOML，可上传文件或粘贴长文本（自动识别或指定格式），JSON/YAML/TOML 可指定非根记录节点，XLSX 多工作表先选表，解析后共用源字段映射、JSON 路径抽取和保存模板；路径样例默认隐藏，整批预检汇总错误并支持下载 CSV 报告；逻辑唯一 KEY 可组合多个字段，重复项默认更新，也可跳过，完整批次支持删除缺失项。
- **表格与常用查询**：单数据集范围可切换表格，配置公开字段列及本次解锁期间的列宽，跨数据集继续使用摘要。常用查询在独立弹窗中展示完整条件；管理会话可将搜索词、目录、标签、模型、数据集和过期选项保存为保险库常用查询，支持应用、更新和删除，随加密数据库及逻辑备份保存；原范围失效时会提示处理，不自动扩大搜索范围。
- **附表关联选择**：用公开标识卡片分页检索并选择主记录，展开查看识别信息，已占用记录不可选择；系统 ID 位于高级入口，新建或更换关联时在保存前验证所属数据集与占用状态。手机及低高度窗口保留固定页头与保存操作区。
- **数据模型与多标签**：同类数据集引用一套主表/附表结构、逻辑 KEY 和默认展示配置，可在模型说明中记录共用提取方法与 SQL；客户、环境等分类统一用多个标签表达，筛选按标签交集匹配；标签支持引用已有项或输入新名称并随数据集保存自动创建。数据集实例分别保存记录、导入模板和应用授权。旧库在带密码启动或首次解锁时自动升级，保留数据集/记录 ID、密文和原有授权，每个旧数据集先获得独立模型，可手动预览并合并到数据模型。结构修改经预览后统一发布，失败整体回滚。见 [数据模型与运行时升级](docs/SHARED_SCHEMAS.md)。
- **数据集管理与下载**：管理、编辑和导入在主窗口操作，单个数据集默认展示紧凑只读信息，数据集属性与模型定义分别维护，模型字段与列表展示规则在同一编辑表中调整；导出支持仅结构、仅数据、结构与数据，默认不包含机密数据；可下载文件，也可生成长文本后查看、全选和复制。仅数据导出支持 JSON、JSONL、CSV、XLSX、YAML（.yaml / .yml）、TOML。XLSX 将字段值作为文本保存，保留前导零和长编号。TOML 使用 `[[records]]` 数组表，遇到 null 或超出 64 位有符号范围的整数会提示改用 JSON/JSONL/YAML；详见 [数据集格式说明](docs/DATASET_FORMAT.txt)。
- **数据集描述**：每个数据集可保存多行 Markdown 长文本，默认紧凑只读，点击“修改描述”才打开独立编辑器；支持标题、列表、表格和 SQL 等代码块。描述原文随加密数据库和逻辑备份保存。在数据集编辑页中，描述先加入草稿，随“保存数据集”一起生效；属性与模型字段支持修改标记和单项撤回，模型字段按单行紧凑排列，展示规则直接可用，点击首列序号调整位置，无需额外的排序列。
- **检索页数据集入口**：选择具体数据集后可通过图标查看说明与字段定义，管理会话可直接编辑或导入；同目录有多个数据集时可按数据集和多个标签选择。
- **普通与忽略字段**：普通字段不参与检索或列表展示，仅在详情中展示，并包含在常规导出中；忽略字段保留 Schema 规则，导入值不写入数据库，不能作为逻辑 KEY。将已有字段改为忽略会清除原值。
- **手工编辑**：按原值使用文本或 JSON 输入，不将列表展示格式当作强制值类型；可按需改用多行输入。修改后显示细边框、星号与撤回图标；清空值明确表示设为 `null`，逻辑 KEY 不允许清空。未编辑字段和敏感原值保持不变，保存前汇总修改与清空数量；JSON 错误定位到字段和行列，失败保留草稿。
- **主表与附表**：主表支持手工新增、编辑和删除记录，后续批量导入仍可更新主表。每个数据集有一个独立附表，可自定义普通、敏感等字段，与主表记录一对一关联；主表导入不会覆盖附表。数据集管理页和检索页的附表入口支持字段管理、查看、编辑、重新关联、删除和批量清理失联记录，主记录详情支持直接新增或编辑附表。附表的索引和展示字段参与组合搜索，可用 `supplement.字段名:` 或 `附表.字段名:` 单独过滤附表；普通、敏感和隐藏字段不参与搜索。
- **附表关联**：优先使用全部属于索引区域的逻辑 KEY，未满足条件时使用所有索引字段组合；没有索引字段时使用主表系统 ID。现存主记录的索引、字段名或 KEY 变化时，整个附表跟随更新；主记录删除后附表保留，重导入相同索引且唯一匹配时恢复关联。重复、不完整或无法从失联主记录取得新索引值时，不自动猜测关联，可手工重新选择主记录或清理。旧版重复关联的多余记录保留为失联记录，不自动删除。
- **移动端**：顶部锁定和会话控制区随页面滚动保持可见；手机端重新排列搜索、操作按钮、字段和弹窗，支持触控操作。
- **检索排序**：分页前按匹配度排序，完整值优先于完整词段、前后缀和局部包含；多关键词兼顾完整短语及同字段集中命中，同等匹配优先公开逻辑 KEY 和记录标识。目录等显式筛选不加分；命中字段也按相关程度前置。匹配与评分合并，使用有界候选堆获得与全排序一致的分页，保留准确总数。见 [检索排序规则](docs/SEARCH_RULES.txt)及 [性能验证](docs/SEARCH_PERFORMANCE.txt)。
- **应用接入**：应用可分别设置只搜索或敏感字段权限，指定可访问数据集，设置授权时效，并支持停用和密钥轮换。已验证凭据的应用遇到授权到期、范围不足或敏感信息权限不足时，“接入应用”显示未读红点并提供原因和处理入口；重复失败合并，可忽略或关闭本次解锁提醒。事件仅在本次解锁期间保留，不保存查询、字段值或密钥。
- **httpyac 按需取值**：提供可复用的 MJS 脚本，在请求执行前按数据集 ID 或名称、多个标签和模型定位唯一记录，读取主表、附表及获授权的敏感字段，并映射为请求变量。脚本、示例和配置见 [httpyac 接入说明](extensions/httpyac/README.md)。
- **Raycast 查询入口**：独立扩展支持主表与附表联合搜索、目录/多标签/模型/数据集筛选、非敏感详情及字段复制；需要敏感信息时一键打开网页中的对应记录，锁定时解锁后继续定位。安装与配置见 [Raycast 扩展说明](extensions/raycast/README.md)。
- **结构迁移**：Schema 文件保留字段区域、逻辑 KEY、列表规则、记录标识、Markdown 描述及附表定义；原生数据集包还可包含主表、附表和模板。导入先预览，确认后事务提交，结构差异与模板重名有明确提示。见 [数据集交换格式](docs/DATASET_FORMAT.txt)。
- **统一工作台**：检索、数据集、接入应用采用统一导航，支持浅色与深色，未解锁首页也可切换主题；宽屏并排阅读记录详情，桌面两栏/三栏支持拖动宽度、方向键微调、双击复位并记住宽度；窄屏使用弹层，手机详情使用全屏。Cmd/Ctrl+K 定位检索，结果支持方向键与 Enter。
- **应用管理与授权**：按名称、ID 和状态筛选应用，独立查看授权数据集及到期时间；创建时一次选择访问级别、范围和期限，密钥仅显示一次。编辑授权默认保留原到期时间，支持搜索数据集、批量选择匹配项和只看已选；到期或停用应用可明确重新授权并启用。
- **单文件发布**：release 二进制嵌入前端资源；开发模式直接读取 `web/`，无需为页面修改重新编译。

以下截图更新于 **2026-10-21**，来自当前 Rust 服务与 Web 界面。使用独立创建的虚构演示库：**8 个数据集、98 条记录、308 个加密字段**，其中 4 条记录过期，默认检索显示 94 条；另加入常用查询、模型说明和附表演示。截图不包含主密码、应用密钥或敏感字段明文，也未访问现有保险库。

全部图片采用压缩 WebP：桌面不超过 **1440 × 960**，手机约 **393 × 852**，单张不超过 **160KiB**。复现与压缩方法见 [截图维护说明](docs/screenshots/README.md)。

![检索工作台与分类目录](docs/screenshots/overview.webp)

<details>
<summary>延迟检索、表格与常用查询</summary>

停止输入 500ms 后自动搜索，Enter 立即执行。未完成或非法条件会保留上次结果，不忽略条件扩大范围；筛选摘要集中表达目录、标签、模型和数据集范围。

输入 `category:=游戏业务 gid:=2001 platform:=Android` 可对照三个环境中的同一产品；正式环境的 SDK 版本已通过复合 KEY 更新为 `3.3.1`。

![跨环境字段检索与命中高亮](docs/screenshots/search.webp)

限定单个数据集后可切换表格，调整公开字段列及列宽；跨数据集保留摘要视图。

![单数据集表格视图](docs/screenshots/table.webp)

常用查询在弹窗中完整展示范围，支持保存、应用、更新和删除；旧范围失效时需要明确处理，不自动扩大检索。

![常用查询与完整条件预览](docs/screenshots/saved-queries.webp)

</details>

<details>
<summary>记录详情、字段复制与主表编辑</summary>

桌面目录、结果、详情支持拖动分栏宽度，也可用方向键微调、双击复位。详情固定标题、标签和底部操作，字段按模型顺序连续展示；复制采用带字段名提示的图标，支持键盘操作。编辑与删除直接显示，删除仍需确认。

![可调整分栏的记录详情](docs/screenshots/detail.webp)

敏感字段默认掩码，按需查看 30 秒后恢复；隐藏字段仅加密存储，不提供查看入口。

![敏感信息默认掩码](docs/screenshots/secrets.webp)

附表与主表分别维护，批量导入主表不会覆盖附表信息。

![记录详情中的附表扩展数据](docs/screenshots/supplement.webp)

字段修改后出现标记与撤回按钮；清空明确表示 `null`，逻辑 KEY 保留必填约束。截图中的修改仍为未保存草稿。

![主表字段修改标记与撤回](docs/screenshots/record-edit.webp)

</details>

<details>
<summary>数据集管理、属性与数据模型</summary>

管理列表按名称、目录、标签与数据模型组织信息；常用操作保持直接可见，其他操作放入有边界的菜单。

![数据集管理列表](docs/screenshots/datasets.webp)

数据集名称直接作为标题，基本属性使用紧凑文本；数据集与模型分别展示描述，空描述按入口需要隐藏或保留添加入口。模型主表、附表使用连续字段表，合并字段用途与检索展示信息，省略重复标签、字段数量和版本号。

![数据集信息与引用模型分开展示](docs/screenshots/dataset-info.webp)

![数据模型统一查看界面](docs/screenshots/model-info.webp)

修改数据集只影响当前实例的名称、目录、标签与描述；模型详情及编辑入口集成在数据集信息和编辑流程中。

![数据集属性编辑与模型引用](docs/screenshots/dataset-edit.webp)

模型字段按单行紧凑排列，KEY、列表展示、记录标识等常用控件直接可用；点击首列序号调整位置。共享模型发布前预览影响范围，引用的数据集记录和授权继续独立管理。

![紧凑的数据模型编辑器](docs/screenshots/model-edit.webp)

</details>

<details>
<summary>导入路径样例、批量预检与结构导出</summary>

导入分为选择来源、配置、确认三个步骤。来源支持文件和粘贴文本。映射模板与路径样例用于检查抽取结果；前 3 条样例默认隐藏，需要时临时查看。截图使用 Webhook 模板抽取 `config.endpoint`，不展示样例明文。

![真实导入模板与路径样例预览](docs/screenshots/import.webp)

整批预检按记录、字段与路径列出问题，支持定位字段和下载 CSV 检查报告。截图演示路径未命中的提醒及更新时可能清除旧值的影响；未确认前不写入记录。

![批量预检与检查报告下载](docs/screenshots/import-report.webp)

导出支持仅结构、仅数据、结构与数据；仅结构包含字段用途、逻辑 KEY、描述、展示配置及附表定义，不包含记录值。

![仅结构导出配置](docs/screenshots/export.webp)

</details>

<details>
<summary>应用授权、未读红点与最近事件</summary>

应用列表按名称、ID 和状态筛选，区分只读检索、敏感信息查看、停用和到期状态。

![应用权限与有效期状态](docs/screenshots/apps.webp)

只有 ID 和当前密钥已验证、但因授权受阻的应用触发红点；错误密钥不会制造提醒。红点表示尚未查看的事件类别。

![主导航中的应用授权事件红点](docs/screenshots/authorization-notice.webp)

最近事件展示请求发生时的原因、时间与累计次数，提供重新授权、配置数据集或审核权限的入口。重复失败合并；看过同类事件后只更新计数，可忽略此类事件或关闭本次解锁提醒，事件仍可查看。修改配置后需从应用重试，不自动提升权限或宣称已经恢复。

事件只在**本次解锁期间**保留，最多 100 类，封印或重新解锁后清空；不保存查询、字段值和密钥，不作为长期安全审计记录。

![授权事件原因与管理员处理入口](docs/screenshots/authorization-events.webp)

授权编辑默认保留原到期时间；支持搜索数据集、选择匹配项与只看已选。保存前汇总权限、范围和期限变化，管理员明确确认后才生效。

![应用授权范围与保存前摘要](docs/screenshots/authorization.webp)

</details>

<details>
<summary>未解锁首页主题与深色工作台</summary>

未解锁首页也可切换明暗主题，与工作台共享偏好；服务离线时仍可使用，不触发解锁表单提交。

![未解锁首页的浅色主题](docs/screenshots/locked-light.webp)

![未解锁首页的深色主题](docs/screenshots/locked-dark.webp)

![深色检索与并排详情](docs/screenshots/dark.webp)

</details>

<details>
<summary>手机检索、目录多选、全屏详情与授权事件</summary>

手机保留顶部封印入口和底部导航，摘要随宽度调整。目录使用独立面板，多选取并集，父目录包含子目录，应用筛选后返回检索。

<img src="docs/screenshots/mobile.webp" alt="手机端检索与顶部控制区" width="360" />
<img src="docs/screenshots/mobile-directory.webp" alt="手机端分类目录多选" width="360" />

记录详情使用全屏布局，标题、标签和编辑/删除操作固定，字段独立滚动；复制与其他触控入口保留足够的点击区域。授权事件在窄屏纵向排列，保留处理与提醒开关。

<img src="docs/screenshots/mobile-detail.webp" alt="手机端全屏记录详情" width="360" />
<img src="docs/screenshots/mobile-authorization.webp" alt="手机端应用授权事件" width="360" />

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

项目新增 Tauri 桌面入口，可用 `make desktop` 启动、`make desktop-package` 生成本机应用包。桌面版复用完整工作台，提供原生保存与复制、单实例和退出清理，默认使用独立的系统应用数据目录。构建依赖、打开已有保险库、平台状态与验证方法见 [桌面版说明](docs/DESKTOP.md)。

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

导入导出真实 HTTP 回归：先运行 `cargo build --locked --manifest-path server/Cargo.toml`，再运行 `python3 tests/helpers/transfer-e2e.py`。脚本在 `samples/.build/` 下创建并清理隔离测试库，覆盖文件和文本的解析、预检、提交、再次导出及异常处理；报告保存在 `samples/.build/transfer-e2e-report.json`。追加 `--serve` 可保留测试服务供浏览器验证，按 Ctrl-C 后清理。

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
