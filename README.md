# SecureVault

Rust 服务端与静态 Web 界面的本地保险库。

## 功能与演示

SecureVault 将不同业务的数据集集中管理，按目录和环境检索，并将字段分为索引、展示、隐藏加密和敏感四个区域。数据库使用 SQLCipher 加密，受保护字段另用 AES-256-GCM 加密；敏感字段按需查看，界面明文展示 30 秒后恢复掩码。

- **检索与展示**：支持空格 AND、字段精确匹配、前缀、后缀和正则；目录筛选包含子目录，环境可独立切换，过期记录默认隐藏。列表支持字段顺序、可见性及单行、多行、JSON 格式。
- **导入与更新**：支持 JSON、CSV、XLSX，源字段映射、JSON 路径抽取和保存模板；逻辑唯一 KEY 可组合多个字段，重复项默认更新，也可跳过，完整批次支持删除缺失项。
- **应用接入**：应用可分别设置只搜索或敏感字段权限，指定可访问数据集，设置授权时效，并支持停用和密钥轮换。
- **单文件发布**：release 二进制嵌入前端资源；开发模式直接读取 `web/`，无需为页面修改重新编译。

以下截图来自仓库提供的虚构演示数据，包含游戏产品、支付商户、云服务、Webhook、运行手册和平台配置，共 **8 个数据集、98 条记录、308 个加密字段**。其中 4 条记录过期，默认检索显示 94 条。

![演示总览与分类检索](docs/screenshots/overview.webp)

<details>
<summary>字段检索与多环境结果</summary>

输入 `category:=游戏业务 gid:=2001 platform:=Android`，可同时查询正式、测试和预发布环境中的同一产品，匹配字段优先展示。正式环境的 SDK 版本已通过复合 KEY 更新为 `3.3.1`。

![字段检索与环境对照](docs/screenshots/search.webp)

</details>

<details>
<summary>记录详情与敏感字段掩码</summary>

详情展示索引、展示和受保护字段；列表隐藏的普通字段仍可在详情查看。敏感字段入口按需解密或复制，隐藏字段不提供直接解密。

![记录详情和字段分区](docs/screenshots/detail.webp)

![敏感字段默认掩码](docs/screenshots/secrets.webp)

</details>

<details>
<summary>导入工作台与 JSON 路径抽取</summary>

上传原始文件后，在提交导入前检查源字段、目标字段、JSON 路径和重复处理策略。截图展示 Webhook 文件的保存模板及 `config.endpoint` 抽取。

![导入映射与模板](docs/screenshots/import.webp)

</details>

<details>
<summary>应用状态与数据集授权</summary>

演示包含只读检索、支付验签、已停用和已过期四种应用。只读机器人仅授权正式游戏和运行手册，可检索但不可解密。

![应用权限与有效期状态](docs/screenshots/apps.webp)

![应用可访问数据集配置](docs/screenshots/authorization.webp)

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

需要 Rust stable（支持 edition 2024）、Make、C/C++ 编译工具及 Perl；SQLCipher 与 OpenSSL 从源码构建。

```sh
make             # 编译 release 二进制
make check       # 检查代码
make test        # 运行测试
make run         # 从源码运行
make run ARGS='--port 8080'
make package     # 生成 dist/securevault-<版本>-<平台>.tar.gz
make clean       # 清理构建产物和 dist
```

默认构建本机平台，可通过 `make package TARGET=x86_64-unknown-linux-gnu` 指定 Rust target（须自行安装对应工具链与链接器）。Makefile 使用已提交的 `server/Cargo.lock` 固定依赖版本。

发布包仅包含 `securevault` 单个二进制，HTML、CSS、JavaScript 及其他 `web/` 资源在构建时自动嵌入，无需额外分发前端目录。解压后执行 `./securevault`，访问 `http://127.0.0.1:4173`，默认将数据写入二进制同目录的 `data/`。`make run` / debug 构建仍直接读取项目的 `web/`，便于修改前端后刷新调试；release 构建始终使用嵌入资源，更新前端后需要重新构建并替换二进制。构建脚本会监测 `web/` 的文件变化及新增、删除，自动重新生成嵌入资源。可用 `--data-dir PATH`、`--port PORT`、`--addr HOST:PORT` 覆盖默认设置，或使用 `SECUREVAULT_DATA_DIR`、`SECUREVAULT_ADDR` 环境变量。

## 自动发布

将 `server/Cargo.toml` 的版本号更新为目标版本；如果依赖或包版本有变化，运行 `cargo check --manifest-path server/Cargo.toml` 更新锁文件，并一并提交。

推送与 Cargo 版本一致的 `v` 标签即可触发 GitHub Actions，例如版本 `0.1.0`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

工作流测试并构建 Linux x86_64（Ubuntu 24.04）与 macOS Apple Silicon 的发布包，全部成功后创建 GitHub Release，附带自动生成的版本说明、压缩包和 `SHA256SUMS`。Linux 包使用 glibc，运行环境需兼容 Ubuntu 24.04 的系统库。含 `-` 的版本标签（如 `v0.2.0-rc.1`）标记为预发布；重跑工作流会更新已有 Release 的附件。无需额外 Token，发布任务使用仓库的 `GITHUB_TOKEN`。
