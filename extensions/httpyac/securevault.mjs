/**
 * httpyac 请求前，临时从 SecureVault 读取所需字段。无第三方依赖，无磁盘缓存或日志。
 * require(.mjs) 需要 Node >= 20.19 / >= 22.12；也可在普通 ESM 中 import。
 *
 * 同目录 .http 用法（SECUREVAULT_APP_ID / SECUREVAULT_APP_KEY 由进程环境提供）：
 *
 * {{
 *   const { loadFields } = require('./securevault.mjs');
 *   exports.vault = loadFields({
 *     baseUrl: 'http://127.0.0.1:4173', // 也可包含 /api，或设置 SECUREVAULT_URL
 *     // appId: vaultAppId, appKey: vaultAppKey, // 可改用 httpyac 环境变量
 *     datasetId: '替换为数据集 ID',
 *     tags: ['客户A', '生产'], // 同时满足全部标签，与 httpyac 的环境配置无关
 *     query: 'gid:=2001 platform:=Android',
 *     fields: {
 *       gid: 'gid',
 *       appSecret: 'secrets.app_secret',
 *       // endpoint: 'display.endpoint',
 *       // note: 'normal.note',
 *       // channel: 'supplement.channel',
 *       // token: 'supplement.secrets.token',
 *     },
 *   }); // 必须导出 Promise，httpyac 才会等待读取完成
 * }}
 * POST {{host}}/your-api
 * Content-Type: application/json
 *
 * {"gid": {{JSON.stringify(vault.gid)}}, "secret": {{JSON.stringify(vault.appSecret)}}}
 *
 * 支持 recordId 直接定位，或 query / datasetId / datasetName / category / tags / schemaId 组合检索。
 * 检索必须恰好一条；category 包含子目录。过期记录默认拒绝，需 includeExpired:true。
 * fields 也可写成 ['gid', 'secrets.app_secret']，返回对象使用相同名称作键。
 * 裸字段名从主表 indexes/display/normal 查找，并自动按需读取 secrets。
 * 主表可显式指定 indexes./display./normal./secrets.；附表使用 supplement. 前缀。
 * 点号前缀后的内容是完整源字段名，不解析嵌套路径；值保留 JSON 原类型。
 * 缺失、hidden、无权限、封印、网络超时等均抛错，中止当前请求。
 * 每次调用重新取值，不写入 $global；调用方应按需使用，勿打印或持久化敏感值。
 * 服务端返回的 30 秒是界面展示时限；本模块不会定时销毁调用方取得的值。
 * httpyac 脚本与 Promise 规则：https://httpyac.github.io/guide/scripting.html
 */

import http from 'node:http';
import https from 'node:https';

const own = (object, key) => object != null && Object.hasOwn(object, key);
const fail = (message) => new Error(`[SecureVault] ${message}`);

function getJson(base, headers, timeoutMs, path, body) {
  const url = new URL(base.href);
  // 保留反向代理的路径前缀；不跟随重定向，避免转发应用凭据。
  url.pathname += path.split('?')[0];
  url.search = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(payload === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
      },
    });
    const timer = setTimeout(() => request.destroy(fail('请求超时')), timeoutMs);
    const done = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    request.on('error', () => done(fail('请求失败或超时，请检查服务地址和网络')));
    request.on('response', (response) => {
      const status = response.statusCode;
      if (status !== 200) {
        const hints = {
          401: '应用凭据错误或缺失',
          403: '应用权限、数据集授权、停用状态或有效期不满足要求',
          404: '记录或字段不存在',
          423: '保险库已封印，请先在网页解锁',
        };
        done(fail(`HTTP ${status}：${hints[status] || '接口调用失败'}`));
        response.destroy();
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('error', () => done(fail('响应读取失败')));
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          done(fail('接口响应超过 2 MiB'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          done(fail('接口未返回有效 JSON'));
        }
      });
    });
    request.end(payload);
  });
}

/** @returns {Promise<Record<string, unknown>>} 仅包含 fields 指定的字段。 */
export async function loadFields(options = {}) {
  const {
    baseUrl = process.env.SECUREVAULT_URL || 'http://127.0.0.1:4173',
    appId = process.env.SECUREVAULT_APP_ID,
    appKey = process.env.SECUREVAULT_APP_KEY,
    recordId, query = '', datasetId, datasetName, category, schemaId, tags = [], environment,
    fields, timeoutMs = 10000, includeExpired = false,
  } = options;
  if (typeof appId !== 'string' || !appId.trim() ||
      typeof appKey !== 'string' || !appKey.trim()) {
    throw fail('请配置 appId/appKey 或 SECUREVAULT_APP_ID/SECUREVAULT_APP_KEY');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw fail('timeoutMs 必须为正整数');
  if (typeof includeExpired !== 'boolean') throw fail('includeExpired 必须为布尔值');
  for (const value of [recordId, datasetId, datasetName, category, schemaId, environment]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw fail('记录 ID、数据集 ID、名称、目录、模型 ID 和兼容标签应为非空字符串');
    }
  }
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.length)) {
    throw fail('tags 必须为非空标签名称组成的数组');
  }
  const selectedTags = [...new Set([...tags, ...(environment === undefined ? [] : [environment])])];
  if (selectedTags.length > 64) {
    throw fail('最多筛选 64 个标签');
  }
  if (typeof query !== 'string') throw fail('query 必须为字符串');
  if (recordId && (query || datasetId || datasetName || category || schemaId || selectedTags.length)) {
    throw fail('recordId 与检索条件请二选一');
  }
  if (!recordId && !query.trim() && !datasetId && !datasetName && !category && !schemaId && !selectedTags.length) {
    throw fail('请提供 recordId 或至少一个检索条件');
  }
  if (!fields || typeof fields !== 'object') throw fail('请提供 fields 数组或字段映射');
  const entries = Array.isArray(fields) ? fields.map((name) => [name, name]) : Object.entries(fields);
  if (!entries.length || entries.some(([name, source]) =>
    typeof name !== 'string' || !name.trim() || typeof source !== 'string' || !source.trim())) {
    throw fail('fields 必须包含非空的变量名与源字段名');
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw fail('baseUrl 必须是完整 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw fail('baseUrl 仅支持不含用户信息、查询参数或片段的 HTTP(S) 地址');
  }
  // URL 会把空 pathname 立即归一化成 /，须先拼完再赋值，避免根地址变成 //api。
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = prefix.endsWith('/api') ? prefix : `${prefix}/api`;
  const headers = { Accept: 'application/json', 'X-App-Id': appId, 'X-App-Key': appKey };
  const api = (path, body) => getJson(base, headers, timeoutMs, path, body);
  let id = recordId;
  let resolvedDatasetId = datasetId;
  // 名称不是唯一键。只在当前应用授权的实例中精确匹配，并拒绝含糊的选择。
  if (datasetName !== undefined) {
    const metadata = await api('/client/datasets');
    if (!Array.isArray(metadata?.datasets)) throw fail('数据集信息响应格式异常');
    const candidates = metadata.datasets.filter(dataset => {
      const name = dataset.name?.trim() || dataset.category_path?.split('/').filter(Boolean).at(-1);
      const labels = dataset.environments ?? (dataset.environment ? [dataset.environment] : []);
      return name === datasetName.trim() && (!datasetId || dataset.id === datasetId) &&
        (!category || dataset.category_path === category || dataset.category_path?.startsWith(`${category}/`)) &&
        (!schemaId || dataset.schema_id === schemaId) && selectedTags.every(tag => labels.includes(tag));
    });
    if (!candidates.length) throw fail('授权范围内未找到符合名称、目录、标签和模型条件的数据集');
    if (candidates.length !== 1) throw fail(`名称匹配到 ${candidates.length} 个数据集，请补充目录、标签或 datasetId`);
    resolvedDatasetId = candidates[0].id;
    if (typeof resolvedDatasetId !== 'string' || !resolvedDatasetId) throw fail('接口未返回有效数据集 ID');
  }
  if (!id) {
    const params = new URLSearchParams({ q: query, page: '1', limit: '2', include_expired: String(includeExpired) });
    for (const [key, value] of Object.entries({ dataset_id: resolvedDatasetId, category, schema_id: schemaId })) {
      if (value !== undefined) params.set(key, value);
    }
    // 保留旧单环境请求参数，已有调用也可继续连接旧版服务。
    if (environment !== undefined) params.set('environment', environment);
    if (selectedTags.length) params.set('environment_tags', JSON.stringify(selectedTags));
    const found = await api(`/records/search?${params}`);
    if (!Array.isArray(found?.records) || !Number.isSafeInteger(found.total) || found.total < 0) {
      throw fail('检索响应格式异常');
    }
    if (found.total === 0) throw fail('未找到记录，请检查检索条件、标签及授权数据集');
    if (found.total !== 1) throw fail(`匹配到 ${found.total} 条记录，请缩小检索范围`);
    id = found.records[0]?.id;
  }
  if (typeof id !== 'string' || !id) throw fail('接口未返回有效记录 ID');
  const detail = await api(`/records/${encodeURIComponent(id)}`);
  if (!detail || detail.id !== id || (resolvedDatasetId && detail.dataset_id !== resolvedDatasetId)) throw fail('记录详情响应格式异常');
  if (detail.expired && !includeExpired) throw fail('记录已过期，如需使用请显式设置 includeExpired:true');
  const loaded = new Map(); // 仅在本次调用内合并重复字段的解密请求。
  async function read(source) {
    if (loaded.has(source)) return loaded.get(source);
    let record = detail;
    let field = source;
    let publicZones = ['indexes', 'display', 'normal'];
    let revealPath = `/records/${encodeURIComponent(id)}/secrets/reveal`;
    if (source.startsWith('supplement.')) {
      const rows = detail.supplement_records;
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].orphan || !rows[0].id) {
        throw fail('附表必须存在且唯一关联到主记录');
      }
      record = rows[0];
      field = source.slice('supplement.'.length);
      publicZones = ['values'];
      revealPath = `/supplement/${encodeURIComponent(record.id)}/secrets/reveal`;
    }
    const zone = publicZones.find((candidate) => field.startsWith(`${candidate}.`));
    let value;
    if (zone) {
      const key = field.slice(zone.length + 1);
      if (!own(record[zone], key)) throw fail(`字段不存在：${source}`);
      value = record[zone][key];
    } else if (!field.startsWith('secrets.') && publicZones.some((candidate) => own(record[candidate], field))) {
      value = record[publicZones.find((candidate) => own(record[candidate], field))][field];
    } else {
      const key = field.startsWith('secrets.') ? field.slice('secrets.'.length) : field;
      const protectedField = record.protected_fields?.find((candidate) => candidate.field_name === key);
      if (protectedField?.zone === 'hidden') throw fail(`hidden 字段不提供读取接口：${source}`);
      if (!key || protectedField?.zone !== 'secrets') throw fail(`字段不存在：${source}`);
      const revealed = await api(revealPath, { field_name: key });
      if (!own(revealed, 'value')) throw fail('敏感字段响应缺少 value');
      value = revealed.value;
    }
    loaded.set(source, value);
    return value;
  }
  // 所有字段成功后才返回，避免调用方使用不完整结果。
  const result = Object.create(null);
  for (const [name, source] of entries) result[name] = await read(source);
  return result;
}

export default loadFields;
