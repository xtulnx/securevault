# httpyac 接入支持

使用 [securevault.mjs](securevault.mjs) 在 httpyac 执行请求前，按需从 SecureVault 读取主表、附表及敏感字段，并映射为当前请求的变量。脚本没有第三方依赖，每次调用重新获取，不写入磁盘缓存。

## 准备

1. 启动 SecureVault，在网页中解锁保险库。
2. 在“接入应用”创建应用，授权需要的数据集。读取非敏感字段选择“只搜索”；读取敏感字段需授予敏感字段权限。保存应用 ID 和应用密钥。
3. 将本目录的 `securevault.mjs` 复制到使用方项目的 `.http` 文件旁边；可同时复制 [example.http](example.http) 作为起点。
4. httpyac 使用的 Node.js 运行时需支持 `require(.mjs)`：Node 20.x 至少为 20.19，Node 22.x 至少为 22.12，也可使用后续支持此功能的版本。

在启动 httpyac 的进程环境中提供 `SECUREVAULT_APP_ID` 和 `SECUREVAULT_APP_KEY`，可选设置 `SECUREVAULT_URL`（默认 `http://127.0.0.1:4173`）。VS Code 扩展读取其进程环境；如果使用 httpyac 的环境变量配置，可在调用时显式传入 `appId`、`appKey` 和 `baseUrl`。

## 请求前读取

```http
{{
  const { loadFields } = require('./securevault.mjs');
  exports.vault = loadFields({
    datasetId: '替换为数据集 ID',
    tags: ['客户A', '生产'],
    // schemaId: '替换为数据模型 ID',
    query: 'gid:=2001 platform:=Android',
    fields: {
      gid: 'gid',
      appSecret: 'secrets.app_secret',
    },
  });
}}
POST {{host}}/your-api
Content-Type: application/json

{
  "gid": {{JSON.stringify(vault.gid)}},
  "secret": {{JSON.stringify(vault.appSecret)}}
}
```

将 `host`、目标接口、数据集、查询和字段改为业务需要的值。必须将 `loadFields()` 返回的 Promise 赋给 `exports.vault`，httpyac 才会在替换请求变量前等待读取完成。JSON 请求体使用 `JSON.stringify`，保留字符串、数字、布尔值、空值和对象的类型，并正确处理转义。规则见 [httpyac 脚本文档](https://httpyac.github.io/guide/scripting.html)。

普通 ESM 脚本也可使用 `import { loadFields } from './securevault.mjs'`，再通过 `await loadFields(...)` 获取对象。

## 定位记录与选择字段

| 参数 | 说明 |
| --- | --- |
| `recordId` | 直接使用主记录 ID；不能同时传入检索条件 |
| `query` | 项目现有的搜索语法，例如 `gid:=2001 platform:=Android` |
| `datasetId` | 限定数据集实例 ID，最稳定的定位方式 |
| `datasetName` | 按数据集显示名称精确定位；未设名称时使用目录末段。只在应用已授权的数据集中匹配，必须唯一 |
| `schemaId` | 限定引用的数据模型 ID；同模型实例仍各自受数据集授权约束 |
| `category` | 限定目录，包含子目录 |
| `tags` | 标签名称数组，例如 `["客户A", "生产"]`，全部满足才命中。数组项按完整名称精确匹配，不去掉空格、不按逗号或斜杠拆分 |
| `environment` | 兼容旧单环境参数，视为一个标签；和 `tags` 同传时取交集，与 httpyac 环境配置分别设置 |
| `fields` | `{ 返回变量名: 源字段 }`，也可传字段名数组，返回键与数组项相同 |
| `includeExpired` | 默认 `false`；需显式设为 `true` 才可读取过期记录 |
| `timeoutMs` | 每次接口调用的超时，默认 10000 毫秒 |
| `baseUrl` | 服务地址，可含 `/api` 或反向代理路径前缀 |
| `appId` / `appKey` | 应用凭据；省略时读取对应的进程环境变量 |

名称和模型名称都不是唯一标识。指定 `datasetName` 时，先按目录、标签、`schemaId`、`datasetId` 缩小已授权数据集范围；同名仍有多个时抛错，不会自动选择第一个。标签按输入顺序去重，最多 64 个；未选择标签时不限制标签。

例如，可将示例中的 `datasetId` 替换为 `datasetName: '商户凭据'`，并用 `tags: ['客户A', '生产']` 区分同名实例。

没有 `recordId` 时至少提供一个检索条件，且结果必须恰好一条；零条或多条都会抛错。已知记录 ID 时，例如：

```js
exports.vault = loadFields({
  recordId: '替换为主记录 ID',
  fields: {
    gid: 'indexes.gid',
    endpoint: 'display.endpoint',
    note: 'normal.note',
    appSecret: 'secrets.app_secret',
    channel: 'supplement.channel',
    token: 'supplement.secrets.token',
  },
});
```

裸字段名依次查找主表的索引、展示、普通字段，或按其敏感字段定义解密。显式前缀支持 `indexes.`、`display.`、`normal.`、`secrets.`；附表字段使用 `supplement.`，也可显式写成 `supplement.values.字段名`。前缀后的名称是完整源字段名，不解析嵌套 JSON 路径。附表需要存在且唯一关联到主记录。

## 运行与错误处理

复制并调整示例后，可在 VS Code 的 httpyac 扩展中执行，或使用 CLI：

```sh
httpyac example.http --all
```

脚本使用应用凭据访问 `/api/records/search` 和 `/api/records/{id}`；按名称定位时额外读取 `/api/client/datasets`，仅返回已授权实例的名称、标签和模型标识，不访问管理目录或模型取数说明。只为请求的敏感字段调用主表或附表的 `secrets/reveal` 接口。不会自动解锁保险库，`hidden` 字段不提供读取接口。

凭据错误（401）、权限或授权状态不满足要求（403）、保险库封印（423）、字段缺失、记录不唯一、记录过期和网络错误均会抛错，使当前业务请求中止。先在网页检查解锁状态、应用授权和记录，再重新执行。请求不会跟随重定向，服务地址应直接指向最终的 HTTP(S) 地址。

返回值由调用方持有；脚本不写入 `$global`、不记录字段值。服务端返回的 30 秒是网页展示时限，不会让脚本返回值自动失效。按需读取，避免将敏感值写入请求日志、报告或持久变量。

## 验证

在项目根目录运行 `node --test tests/httpyac.test.cjs`。真实 HTTP 回归执行 `python3 samples/scripts/raycast_check.py`（先构建服务）；回归覆盖两个扩展的授权元数据、多标签、同模型实例隔离及实际 httpyac 取值，使用 `samples/.build/` 下的临时虚构保险库。
