import { test } from "node:test";
import assert from "node:assert/strict";
import { VaultClient, VaultError, recordUrl, serverUrl } from "../src/client";

const configuration = {
  serverUrl: "http://127.0.0.1:4173",
  appId: "APP_ID",
  appKey: "APP_KEY",
};
const filters = {
  datasetId: "ds",
  category: "业务/支付",
  tags: ["客户A", "生产"],
  schemaId: "model-1",
  includeExpired: false,
};

test("URLs accept loopback HTTP or HTTPS and reject embedded credentials and insecure remote origins", () => {
  assert.equal(serverUrl("http://[::1]:4173/").toString(), "http://[::1]:4173/");
  assert.equal(serverUrl("https://vault.example.test/base/").pathname, "/base/");
  for (const url of [
    "file:///tmp/vault",
    "http://vault.example.test",
    "https://user:password@vault.example.test",
    "https://vault.example.test?key=SECRET",
    "invalid",
  ]) {
    assert.throws(() => serverUrl(url), VaultError);
  }
  const link = recordUrl(serverUrl(configuration.serverUrl), "rec_a");
  assert.equal(link, "http://127.0.0.1:4173/#record=rec_a");
  assert.ok(!link.includes(configuration.appKey));
});

test("requests use app headers, no-store, reject redirects, and preserve query/filter encoding", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init: init || {} });
    return Response.json({ records: [], total: 0, page: 2, limit: 40 });
  };
  const client = new VaultClient(configuration, fakeFetch);
  await client.search("附表.alias:=华东 A&B", filters, 2);
  const request = requests[0];
  assert.equal(request.url.pathname, "/api/records/search");
  assert.equal(request.url.searchParams.get("q"), "附表.alias:=华东 A&B");
  assert.equal(request.url.searchParams.get("category"), "业务/支付");
  assert.equal(request.url.searchParams.get("page"), "2");
  assert.deepEqual(JSON.parse(request.url.searchParams.get("environment_tags")!), ["客户A", "生产"]);
  assert.equal(request.url.searchParams.get("schema_id"), "model-1");
  assert.equal(request.url.searchParams.has("environment"), false);
  assert.equal(request.url.searchParams.has("include_expired"), false);
  assert.deepEqual(request.init.headers, {
    "X-App-Id": "APP_ID",
    "X-App-Key": "APP_KEY",
  });
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.method, "GET");
});

test("locked, revoked and invalid credentials remain distinct and do not expose server bodies", async () => {
  for (const [status, pattern] of [
    [423, /锁定/],
    [403, /授权/],
    [401, /凭据/],
  ] as const) {
    const client = new VaultClient(configuration, async () => Response.json({ error: "SERVER_SECRET" }, { status }));
    await assert.rejects(
      client.datasets(),
      (error: VaultError) =>
        error.status === status && pattern.test(error.message) && !error.message.includes("SERVER_SECRET"),
    );
  }
});

test("request cancellation reaches fetch and malformed or mismatched record responses are rejected", async () => {
  const controller = new AbortController();
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const client = new VaultClient(configuration, async (_input, init) => {
    start();
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
    );
  });
  const pending = client.datasets(controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const wrong = new VaultClient(configuration, async () => Response.json({ id: "other", dataset_id: "ds" }));
  await assert.rejects(wrong.detail("rec_a"), /无效的记录/);
  const malformed = new VaultClient(configuration, async () => Response.json({ datasets: null }));
  await assert.rejects(malformed.datasets(), /无效的数据集/);
});
