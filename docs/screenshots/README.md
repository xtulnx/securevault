# README 截图维护

这组截图于 2026-10-21 更新，全部来自当前 Rust 服务和 `web/` 页面，通过浏览器实际操作采集，没有用设计稿代替实现。使用虚构的 8 个数据集、98 条记录、308 个加密字段，其中 4 条记录过期；额外补充名称、说明、常用查询、附表和真实授权拒绝事件以展示新交互。

## 创建隔离演示环境

在项目根目录执行：

```sh
cargo build --manifest-path server/Cargo.toml --offline
python3 tests/helpers/readme-preview.py
```

需要已安装构建依赖，且 Cargo 依赖已缓存；首次构建可去掉 `--offline`。

该服务使用 `127.0.0.1:4189`，端口已占用时会直接拒绝启动。所有数据库、临时日志和状态均位于 `samples/.build/` 中的新目录，绝不复用 `data/` 或 `samples/.runtime/`；退出脚本时终止其子进程并删除临时保险库。初始化会执行原有 18 组演示检查，服务就绪后输出非敏感的统计信息。

浏览器使用脚本中的公开、一次性演示密码 `README-demo-only-2026!` 解锁。这不是实际使用的主密码，不能用于其他保险库。截图在密码输入前或解锁后采集，不能包含密码、一次性应用密钥、解密结果或未掩码的路径样例值。

应用授权事件需要在浏览器解锁之后触发，因为每次解锁会清空事件。脚本就绪后，会将进程号写入 `samples/.build/readme-preview.json`，向该进程发送 `SIGUSR1` 即可用其内存中的虚构应用凭据发起敏感查看、跨数据集、停用和到期四类请求。先停留在检索页查看红点，再进入接入应用截图；不要为截图手工注入前端状态或伪造事件。

## 采集要求

- 桌面使用 1440 × 900 的 CSS 视口，能同时展示目录、检索与详情。手机使用约 393 × 852 的视口。
- 截取实际页面视口，去掉截图工具多出的空白画布；保留页头、当前范围和关键操作，不拉伸图片。
- 等待请求完成和临时提示消失，避免加载状态、密码输入、未处理的确认框或空列表成为最终截图。
- 修改状态截图只使用演示草稿，拍摄后撤回；导入预检截图可使用错误路径，但不得确认写入；演示成功流程选择跳过既有 KEY，维持记录计数。
- 将原始 PNG/JPEG 放到 `samples/.build/readme-shots/`，文件名与最终 WebP 的主名一致。原始文件只留在被 Git 忽略的目录中。
- 涉及新功能时，同时更新根 README 的说明、对应图片与本目录清单，避免新旧 UI 混用。

## WebP 压缩与验证

需要 ImageMagick (`magick`) 和 libwebp (`cwebp`)。在项目根目录执行：

```sh
python3 scripts/optimize_screenshots.py samples/.build/readme-shots
python3 scripts/optimize_screenshots.py --check
```

编码使用有损 WebP，质量 86、method 6、sharp YUV，移除元数据；超出预算时依次降低为 82、78、74。尺寸等比缩小、不放大：桌面最大 1440 × 960，手机保留约 393 × 852 原宽度。单图上限 160KiB，超出会报错，要求缩小采集范围，不无限降低文字质量。README 中手机图显示宽度为 360，避免拉伸至整行。

工具检查 README 实际引用的所有图片，验证 WebP 文件头、尺寸和体积，并生成 [manifest.json](manifest.json)。发布文档前应抽看压缩后的文字、边框和掩码，确认相对链接存在且所有图片均为 WebP。

## 当前画面

| 范围 | 截图 |
| --- | --- |
| 检索与比较 | `overview`、`search`、`table`、`saved-queries` |
| 记录读取与维护 | `detail`、`secrets`、`supplement`、`record-edit` |
| 数据集和数据模型 | `datasets`、`dataset-info`、`model-info`、`dataset-edit`、`model-edit` |
| 导入与导出 | `import`、`import-report`、`export` |
| 应用授权与提醒 | `apps`、`authorization-notice`、`authorization-events`、`authorization` |
| 主题 | `locked-light`、`locked-dark`、`dark` |
| 手机 | `mobile`、`mobile-directory`、`mobile-detail`、`mobile-authorization` |

以上主名均对应本目录的 `.webp` 文件。
