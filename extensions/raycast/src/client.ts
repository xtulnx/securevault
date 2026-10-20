import type { Dataset, Filters, SearchResult, VaultRecord } from "./types";

export interface Configuration {
  serverUrl: string;
  appId: string;
  appKey: string;
}

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function serverUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new VaultError("服务地址无效，请检查扩展设置。");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new VaultError("服务地址须使用 HTTPS；本机回环地址可使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VaultError("服务地址只填写网页地址，不包含凭据、查询参数或记录链接。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url;
}

export function recordUrl(base: URL, id: string): string {
  const url = new URL(base);
  url.hash = new URLSearchParams({ record: id }).toString();
  return url.toString();
}

export class VaultClient {
  readonly base: URL;
  private readonly headers: Record<string, string>;

  constructor(
    configuration: Configuration,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = serverUrl(configuration.serverUrl);
    if (!configuration.appId.trim() || !configuration.appKey.trim()) {
      throw new VaultError("请在扩展设置中填写应用 ID 和密钥。");
    }
    this.headers = {
      "X-App-Id": configuration.appId.trim(),
      "X-App-Key": configuration.appKey.trim(),
    };
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10000);
    try {
      const response = await this.fetcher(new URL(`api/${path}`, this.base), {
        method: "GET",
        headers: this.headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const messages: Record<number, string> = {
          401: "应用凭据无效，请更新扩展设置中的应用 ID 和密钥。",
          403: "应用已停用、授权已过期或无权访问该数据集，请在 SecureVault 中检查授权。",
          404: "记录已不存在，或服务尚未更新到支持 Raycast 的版本。",
          423: "保险库已锁定，请在 SecureVault 中解锁后重试。",
          429: "请求过于频繁，请稍后重试。",
          503: "SecureVault 服务暂不可用，请稍后重试。",
        };
        if (response.status === 400) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new VaultError(body.error || "查询格式无效，请检查搜索条件。", 400);
        }
        throw new VaultError(
          messages[response.status] || `请求失败（${response.status}），请稍后重试。`,
          response.status,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof VaultError || signal?.aborted) throw error;
      throw new VaultError("无法连接 SecureVault，请检查服务地址及服务状态。");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async datasets(signal?: AbortSignal): Promise<Dataset[]> {
    let body: { datasets: Dataset[] };
    try {
      body = await this.get<{ datasets: Dataset[] }>("client/datasets", signal);
    } catch (error) {
      if (error instanceof VaultError && error.status === 404) {
        throw new VaultError("此 SecureVault 服务尚不支持数据集查询，请更新并重启服务后重试。", 404);
      }
      throw error;
    }
    if (!Array.isArray(body.datasets)) throw new VaultError("服务返回了无效的数据集信息。");
    return body.datasets;
  }

  async search(query: string, filters: Filters, page: number, signal?: AbortSignal): Promise<SearchResult> {
    const params = new URLSearchParams({
      q: query,
      page: String(page),
      limit: "40",
    });
    if (filters.datasetId) params.set("dataset_id", filters.datasetId);
    if (filters.category) params.set("category", filters.category);
    if (filters.tags.length) params.set("environment_tags", JSON.stringify(filters.tags));
    if (filters.schemaId) params.set("schema_id", filters.schemaId);
    if (filters.includeExpired) params.set("include_expired", "true");
    const result = await this.get<SearchResult>(`records/search?${params}`, signal);
    if (!Array.isArray(result.records) || !Number.isFinite(result.total)) {
      throw new VaultError("服务返回了无效的搜索结果。");
    }
    return result;
  }

  async detail(id: string, signal?: AbortSignal): Promise<VaultRecord> {
    const result = await this.get<VaultRecord>(`records/${encodeURIComponent(id)}`, signal);
    if (result.id !== id || typeof result.dataset_id !== "string") throw new VaultError("服务返回了无效的记录信息。");
    return result;
  }
}
