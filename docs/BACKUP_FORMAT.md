# 全量逻辑备份与恢复（格式 v1）

## 管理员操作

先停止源库服务。在可信终端运行：

```sh
./securevault backup --data-dir ./data --output ./backup.jsonl.gz.age
./securevault restore --input ./backup.jsonl.gz.age --output-dir ./restored-data
./securevault --data-dir ./restored-data
```

备份时隐藏输入当前主密码、独立备份密码及确认密码；备份密码不能与当前主密码相同。恢复时输入备份密码、新库主密码及确认密码，新主密码不能与备份密码相同。新设置的密码至少 12 个 Unicode 字符、最多 1024 个 UTF-8 字节，建议使用长随机密码并将备份密码单独保管。

`-d` / `--data-dir` 指向包含 `vault/` 的父目录，例如 `samples/.runtime/data`，不能传成 `samples/.runtime/data/vault`。参数只能指定一次；目录层级、旧开发布局、正在使用的源库及已存在的输出在询问密码前就会拒绝。

短名称：`-d` 对应 `--data-dir`，`-i` 对应 `--input`，`-o` 对应 `--output`（备份）或 `--output-dir`（恢复），`-h` 显示帮助。长短名称混用重复指定同一参数也会拒绝。

输出文件/目录必须不存在，父目录必须存在。源目录有独占锁，正在运行的服务会阻止备份。恢复始终创建新的数据目录，不合并、不覆盖、不自动切换原服务。现有库的主密码及数据密钥不进入备份；恢复生成全新的数据库、字段和身份索引密钥。保留所有数据集、记录 ID、敏感及隐藏内容、重复关联、过期状态、时间、导入模板、应用权限与范围、既有审计事件；重建搜索与身份索引，新增恢复审计事件。应用均被停用，旧凭据不导出，恢复后须重新签发并启用。

自动化可加 `-s` / `--passwords-stdin`，读取以下 JSON 对象（不要在 shell 历史、命令行参数或源码中写明文密码）：

```json
{"master_password":"由安全输入渠道提供","backup_password":"由安全输入渠道提供","confirm_password":"由安全输入渠道提供"}
```

备份的 `master_password` 是当前主密码，`confirm_password` 确认备份密码；恢复的 `master_password` 是新库主密码，`confirm_password` 确认新库主密码。CLI 忽略用于启动服务的密码、数据目录及网络环境变量，不启动 HTTP。

## 使用标准工具读取

文件分三层：UTF-8 JSONL → gzip → 标准 age 密码加密。SecureVault 二进制已内置压缩和 age 实现，无需额外命令。若希望独立查看备份内容，使用标准 [age](https://github.com/FiloSottile/age) 和 gzip：

```sh
umask 077
age --decrypt --output backup.jsonl.gz backup.jsonl.gz.age
gzip --decompress --stdout backup.jsonl.gz > backup.jsonl
```

age 会从终端询问备份密码。无需原主密码或 SecureVault，也可以用其他语言解析 JSONL。gzip 本身没有密码功能，必须先解开 age 加密。解密后的 JSONL 包含所有敏感与隐藏字段明文，输出文件、终端、备份软件都应按机密材料管理。

标准工具也可重新封装同一逻辑备份：

```sh
age --passphrase --output repacked.jsonl.gz.age backup.jsonl.gz
```

采用 age 的认证流式加密及密码 scrypt KDF；本工具生成的 scrypt log N 固定为 18，恢复拒绝超过 20 的工作因子。备份密码遗失无法恢复；常规主密码更换不改变既有备份密码，也不会撤销旧备份。

## JSONL 协议

每行一个完整 JSON 对象，以换行结束。首行：

```json
{"type":"header","format":"securevault-logical","version":1,"producer":"0.1.0","created_at":1791504000}
```

`version` 是逻辑格式版本，与工具版本 `producer` 分开。新版工具应持续维护已发布格式的读取器和固定样例回归；格式 v1 必须保持语义稳定。当前读取器只接受 v1，未知版本明确拒绝；不承诺旧工具能读取未来格式。数据库表结构、SQLCipher 和主密码封装可以演进，通过读取器映射到当前数据模型，不要求旧数据文件能直接打开。

中间行使用 `{"type":"类型","data":{...}}`。按照下表顺序分组，空组可以省略。表格中的名字是公开逻辑字段，数组/对象保留 JSON 类型，不使用嵌套 JSON 字符串。

| 类型 | data 字段 |
| --- | --- |
| datasets | id、category_path、environment、fields、identity_fields、conflict_strategy、list_fields、created_at |
| records | id、dataset_id、category_path、environment、indexes、display、duplicate_of、expired、updated_at |
| protected_fields | record_id、source_key、zone、value |
| import_templates | name、dataset_id、mappings、updated_at |
| api_apps | id、name、permission、disabled、datasets、access_expires_at、created_at |
| audit_events | id、event、record_id、field_name、created_at |

`protected_fields.value` 为解密后的原始 JSON 值，`zone` 仅支持 hidden 或 secrets。业务字段仍以现有扁平路径为键，例如 `indexes` 内的 `config.region`，重建身份索引时按路径还原。对象、数组、数字、字符串、布尔及 null 均按 JSON 语义保存；不导出字段 nonce、密文、数据密钥、密钥封装、应用 key_hash、派生 identity_hash 或 search_blob。

`expired`、`disabled` 是整数 0/1；audit_events.id、access_expires_at 是整数，后者可为 null。environment、duplicate_of、审计 record_id/field_name 可为 null。时间字符串保留原值，created_at 首行使用 UTC Unix 秒。字段定义和列表配置沿用公开 API 的结构及枚举，conflict_strategy 当前为 allow_mark。应用导出的 disabled 记录原状态，但恢复时全部强制停用。

末行必须是 end，包含六种数据的实际行数：

```json
{"type":"end","counts":{"datasets":8,"records":98,"protected_fields":308,"import_templates":10,"api_apps":4,"audit_events":20}}
```

这里的计数只是结构示例，恢复会核对实际行数。缺失 end、额外尾行、未知类型/字段、顺序错误、重复主键、无效关联、错误密码、gzip 损坏及 age 截断或认证失败都会拒绝恢复。每行最大 16 MiB、解压后的总数据最大 16 GiB、每类最多 1000 万行；超限时明确失败，不能静默截断。

## 失败与持久化

备份在目标同目录创建 0600 加密临时文件，关闭 gzip 和 age 流、同步文件并完整解密验证之后，以不覆盖目标的硬链接发布，再同步父目录。恢复在 0700 私有临时目录中创建加密数据库，完整读取并认证备份，校验 schema、记录关联、应用授权、模板关联、计数、SQLCipher/SQLite 完整性，关闭并重新打开验证，最后同步并原子发布整目录。不会生成生产明文临时文件。

发布前失败清理本次临时输出，已有源库与备份保持不变；发布后父目录同步失败报告持久化警告，输出已经存在，不能解释为未提交。强制终止进程可能留下 `.backup-*.tmp` 或 `.vault-restore-*` 加密临时对象；管理员确认无相关进程后处理。操作应在可信 macOS/Linux 本地文件系统完成，不支持网络文件系统或恶意同账户进程。

读取密码与主要序列化字节缓冲区使用清零机制，但 JSON 值、解析对象、压缩库和系统内存不保证全部物理清零；备份恢复应在可信主机执行。备份是敏感字段的完整副本，不能撤销已经被解密或复制的历史信息。

## sample 与回归

对当前演示库先停止服务，然后运行（输出放在 Git 忽略的目录中）：

```sh
./securevault backup --data-dir ./samples/.runtime/data --output ./samples/.build/sample.jsonl.gz.age
./securevault restore --input ./samples/.build/sample.jsonl.gz.age --output-dir ./samples/.build/sample-restored
./securevault --data-dir ./samples/.build/sample-restored --port 4180
```

`credentials.json` 中的演示密码和 `manifest.json` 中的旧应用密钥不被打包；恢复后使用新设置的主密码，并重新签发应用凭据。`make demo` 仍是从原始文件全新初始化，不会恢复体验期间的修改。

```sh
cargo build --locked --release --manifest-path server/Cargo.toml
python3 samples/scripts/backup_check.py
```

回归要求系统安装标准 age CLI，仅在 `samples/.build/` 的独立临时目录执行。检查 8 个数据集、98 条记录、全部受保护字段、配置、模板及记录状态恢复一致，源文件不变，旧凭据失效；还使用独立 age 解密和 gzip 读取明文、用独立 age 重新加密后恢复，验证双向互操作及损坏、截断、未来格式拒绝。
