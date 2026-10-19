import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement, type ComponentType, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Dataset, VaultRecord } from "../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const requireDependency = createRequire(__filename);
type Props = { children?: ReactNode; searchBarAccessory?: ReactNode; [key: string]: unknown };
const host = (name: string) => (props: Props) => createElement(name, props, props.children);
const item = Object.assign(
  (props: Props) => createElement("list-item", props, props.detail as ReactNode, props.children),
  { Detail: host("item-detail") },
);
const dropdown = Object.assign(host("dropdown"), { Item: host("dropdown-item") });
const api = {
  List: Object.assign(
    (props: Props) =>
      createElement("list", props, props.searchBarAccessory, props.children, props.actions as ReactNode),
    {
      Item: item,
      Dropdown: dropdown,
      Section: host("section"),
      EmptyView: host("empty"),
    },
  ),
  Action: Object.assign(host("action"), {
    Push: host("push"),
    OpenInBrowser: host("open-browser"),
    CopyToClipboard: host("copy"),
    SubmitForm: host("submit"),
  }),
  ActionPanel: Object.assign(host("actions"), { Section: host("action-section"), Submenu: host("submenu") }),
  Detail: host("detail"),
  Form: Object.assign(host("form"), { Dropdown: dropdown, Checkbox: host("checkbox") }),
  Icon: {},
  Keyboard: { Shortcut: { Common: { Refresh: {}, Open: {} } } },
  getPreferenceValues: () => ({ serverUrl: "http://127.0.0.1:4173", appId: "TEST_APP", appKey: "TEST_KEY" }),
  openExtensionPreferences: () => {},
  useNavigation: () => ({ pop() {} }),
};
const bundle = buildSync({
  entryPoints: [path.join(__dirname, "../src/search.tsx")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "@raycast/api"],
}).outputFiles[0].text;
const moduleObject = { exports: {} as { default: ComponentType } };
new Function("require", "module", "exports", bundle)(
  (name: string) => (name === "@raycast/api" ? api : requireDependency(name)),
  moduleObject,
  moduleObject.exports,
);
const Command = moduleObject.exports.default;

const dataset: Dataset = {
  id: "ds",
  category_path: "业务/支付",
  environment: "正式",
  description: "",
  fields: [{ source_key: "code", display_name: "编号", zone: "indexes", position: 0 }],
  supplement_fields: [],
  identity_fields: ["code"],
  list_fields: [],
  display_config: {},
};
const record: VaultRecord = {
  id: "rec_a",
  dataset_id: "ds",
  category: "业务/支付",
  environment: "正式",
  indexes: { code: "001" },
  display: {},
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function render(t: TestContext, fetcher: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Command));
  });
  t.after(async () => {
    await act(async () => {
      renderer.unmount();
    });
    globalThis.fetch = original;
  });
  return renderer;
}

const find = (renderer: ReactTestRenderer, name: string) => renderer.root.find((node) => node.type === name);
const findAll = (renderer: ReactTestRenderer, name: string) => renderer.root.findAll((node) => node.type === name);

async function settled(renderer: ReactTestRenderer) {
  // Allow the metadata render, debounced search, and selected-record preview.
  for (let attempt = 0; attempt < 25 && find(renderer, "list").props.isLoading; attempt++) await act(pause);
}

test("authorized dataset choices load even when there are no matching records", async (t) => {
  const requests: string[] = [];
  const renderer = await render(t, async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    return Response.json(
      url.pathname.endsWith("client/datasets") ? { datasets: [dataset] } : { records: [], total: 0 },
    );
  });
  await settled(renderer);
  assert.equal(find(renderer, "list").props.isLoading, false);
  assert.ok(findAll(renderer, "dropdown-item").some((option) => option.props.value === "ds"));
  assert.equal(find(renderer, "empty").props.title, "没有匹配的记录");
  assert.equal(findAll(renderer, "section").length, 0);
  assert.deepEqual(requests, ["/api/client/datasets", "/api/records/search"]);
});

test("search errors do not remove successfully authorized dataset choices", async (t) => {
  const renderer = await render(t, async (input) =>
    new URL(String(input)).pathname.endsWith("client/datasets")
      ? Response.json({ datasets: [dataset] })
      : Response.json({}, { status: 500 }),
  );
  await settled(renderer);
  assert.ok(findAll(renderer, "dropdown-item").some((option) => option.props.value === "ds"));
  assert.equal(find(renderer, "empty").props.title, "暂时无法搜索");
  assert.equal(find(renderer, "list").props.isShowingDetail, false);
});

test("a preview failure leaves dataset choices and search results available", async (t) => {
  const renderer = await render(t, async (input) => {
    const pathname = new URL(String(input)).pathname;
    return pathname.endsWith("client/datasets")
      ? Response.json({ datasets: [dataset] })
      : pathname.endsWith("records/search")
        ? Response.json({ records: [record], total: 1 })
        : Response.json({}, { status: 500 });
  });
  await settled(renderer);
  assert.ok(findAll(renderer, "dropdown-item").some((option) => option.props.value === "ds"));
  assert.equal(findAll(renderer, "list-item").length, 1);
  assert.match(find(renderer, "item-detail").props.markdown, /500/);
});

test("metadata failure and zero authorization each show a clear status instead of an empty all-datasets menu", async (t) => {
  for (const [status, title, description] of [
    [404, "数据集加载失败", /更新并重启/],
    [401, "数据集加载失败", /凭据/],
    [423, "数据集加载失败", /锁定/],
    [200, "未授权数据集", /接入应用/],
  ] as const) {
    await t.test(String(status), async (subtest) => {
      const renderer = await render(subtest, async () => Response.json({ datasets: [] }, { status }));
      await settled(renderer);
      assert.equal(find(renderer, "dropdown-item").props.title, title);
      assert.match(find(renderer, "empty").props.description, description);
      assert.equal(find(renderer, "list").props.isLoading, false);
      assert.equal(findAll(renderer, "section").length, 0);
    });
  }
});

test("revoked access clears both results and dataset choices", async (t) => {
  const renderer = await render(t, async (input) => {
    const pathname = new URL(String(input)).pathname;
    return pathname.endsWith("client/datasets")
      ? Response.json({ datasets: [dataset] })
      : pathname.endsWith("records/search")
        ? Response.json({ records: [record], total: 1 })
        : Response.json({}, { status: 403 });
  });
  await settled(renderer);
  assert.equal(find(renderer, "dropdown-item").props.title, "数据集加载失败");
  assert.equal(findAll(renderer, "list-item").length, 0);
  assert.match(find(renderer, "empty").props.description, /授权/);
});

test("connection diagnostics report the configured address and authorization without exposing credentials", async (t) => {
  const requests: string[] = [];
  const renderer = await render(t, async (input) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    return Response.json({ datasets: [] });
  });
  await settled(renderer);
  const target = findAll(renderer, "push").find((action) => action.props.title === "检查连接与授权")!.props.target;
  await act(async () => {
    renderer.update(target);
  });
  for (let attempt = 0; attempt < 10 && find(renderer, "detail").props.isLoading; attempt++) await act(pause);
  const markdown: string = find(renderer, "detail").props.markdown;
  assert.match(markdown, /http:\/\/127\.0\.0\.1:4173\//);
  assert.match(markdown, /没有可访问的数据集/);
  assert.doesNotMatch(markdown, /TEST_KEY|TEST_APP/);
  assert.ok(requests.every((pathname) => pathname === "/api/client/datasets"));
});
