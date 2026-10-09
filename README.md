# SecureVault

Rust 服务端与静态 Web 界面的本地保险库。

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
