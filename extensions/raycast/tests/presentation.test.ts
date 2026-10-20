import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  categories,
  datasetLabel,
  datasetEnvironments,
  datasetChoiceLabel,
  datasetMarkdown,
  matchesFilters,
  publicFields,
  recordIdentity,
  recordMarkdown,
  summary,
  valueBlock,
  valueMarkdown,
} from "../src/presentation";
import type { Dataset, VaultRecord } from "../src/types";

const dataset: Dataset = {
  id: "ds",
  category_path: "业务/支付",
  environment: "正式",
  description: "说明",
  fields: [
    { source_key: "code", display_name: "编号", zone: "indexes", position: 0 },
    {
      source_key: "enabled",
      display_name: "启用",
      zone: "display",
      position: 1,
    },
    { source_key: "notes", display_name: "说明", zone: "normal", position: 2 },
    {
      source_key: "secret",
      display_name: "密钥",
      zone: "secrets",
      position: 3,
    },
    { source_key: "hidden", display_name: "隐藏", zone: "hidden", position: 4 },
    {
      source_key: "ignored",
      display_name: "忽略",
      zone: "ignore",
      position: 5,
    },
  ],
  supplement_fields: [
    { source_key: "alias", display_name: "别名", zone: "indexes", position: 0 },
    { source_key: "memo", display_name: "备注", zone: "normal", position: 1 },
    {
      source_key: "secret",
      display_name: "附表凭据",
      zone: "secrets",
      position: 2,
    },
  ],
  identity_fields: ["code"],
  display_config: { identifier_fields: ["code", "enabled"] },
  list_fields: [
    {
      source_key: "enabled",
      display_name: "启用",
      position: 0,
      visible: true,
      format: "single_line",
    },
  ],
};
const record: VaultRecord = {
  id: "rec-a",
  dataset_id: "ds",
  category: "业务/支付",
  environment: "正式",
  indexes: { code: 0, secret: "MAIN_SECRET" },
  display: { enabled: false, hidden: "HIDDEN_VALUE" },
  normal: { notes: "正常说明", ignored: "IGNORED_VALUE" },
  matched_fields: ["supplement.alias"],
  supplement: {
    id: "sup",
    indexes: { alias: "华东渠道", secret: "ADDON_SECRET" },
  },
  supplement_records: [
    { id: "orphan", orphan: true, values: { memo: "ORPHAN_VALUE" } },
    {
      id: "sup",
      orphan: false,
      values: { alias: "华东渠道", memo: "手工备注", secret: "ADDON_SECRET" },
    },
  ],
};

test("identifiers preserve zero/false, use complete public composite keys and fall back to system ID", () => {
  assert.equal(recordIdentity(record, dataset), "编号：0 · 启用：false");
  assert.equal(recordIdentity(record, { ...dataset, display_config: {} }), "编号：0");
  assert.equal(
    recordIdentity(record, {
      ...dataset,
      display_config: {},
      identity_fields: ["code", "secret"],
    }),
    "记录 #rec-a",
  );
});

test("main and supplement details include normal fields but never protected, ignored or orphan values", () => {
  const fields = publicFields(record, dataset, true);
  assert.deepEqual(
    fields.map((field) => field.value),
    [0, false, "正常说明", "华东渠道", "手工备注"],
  );
  assert.equal(fields.find((field) => field.section === "supplement" && field.label === "别名")?.matched, true);
  const markdown = recordMarkdown(record, dataset, true);
  assert.match(markdown, /附表补充/);
  assert.match(markdown, /手工备注/);
  assert.doesNotMatch(markdown, /MAIN_SECRET|ADDON_SECRET|HIDDEN_VALUE|IGNORED_VALUE|ORPHAN_VALUE/);
});

test("summaries explain supplement hits before default fields and honor list visibility", () => {
  assert.equal(summary(record, dataset), "附表 · 别名：华东渠道 · 启用：false");
  assert.equal(
    summary(
      { ...record, matched_fields: [] },
      {
        ...dataset,
        list_fields: [{ ...dataset.list_fields[0], visible: false }],
      },
    ),
    "",
  );
  assert.equal(
    publicFields(record, dataset).some((field) => field.label === "说明"),
    false,
  );
});

test("empty values are omitted while multiline/JSON content remains intact and cannot inject remote images", () => {
  const payload = "```\n![external](https://example.test/track)\n```";
  assert.equal(valueBlock(payload), "````\n" + payload + "\n````");
  assert.equal(valueMarkdown(payload), valueBlock(payload));
  const fields = publicFields(
    {
      ...record,
      normal: { notes: { value: [0, false] } },
      display: { enabled: " " },
    },
    dataset,
    true,
  );
  assert.equal(
    fields.some((field) => field.label === "启用"),
    false,
  );
  assert.deepEqual(fields.find((field) => field.label === "说明")?.value, {
    value: [0, false],
  });
});

test("compact inline values remain literal text rather than links, images or executable HTML", () => {
  const parser = createRequire(__filename)(path.join(__dirname, "../../../web/vendor/marked.js")) as {
    parse: (markdown: string, options: { gfm: boolean }) => string;
  };
  const hostile = "![image](https://example.test/track) <script>alert(1)</script> [link](https://example.test)";
  const markdown = recordMarkdown({ ...record, normal: { notes: hostile } }, dataset, true);
  const html = parser.parse(markdown, { gfm: false });
  assert.doesNotMatch(html, /<(?:img|script|a|h1|pre)\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<strong>说明<\/strong>/);
});

test("directory options include authorized parents and preserve separate branches", () => {
  assert.deepEqual(categories([dataset, { ...dataset, id: "other", category_path: "业务/云/账号" }]), [
    "业务",
    "业务/云",
    "业务/云/账号",
    "业务/支付",
  ]);
});

test("optional dataset names retain directory and labels while older servers keep existing labels", () => {
  assert.equal(datasetLabel({ ...dataset, name: "商户凭据" }), "商户凭据 · 业务/支付 · 正式");
  assert.equal(datasetLabel({ ...dataset, name: "" }), "业务/支付 · 正式");
  assert.equal(datasetLabel(dataset), "业务/支付 · 正式");
});

test("multi-label filters intersect directory and model by ID, preserving arrays and legacy fallback", () => {
  const current = {
    ...dataset,
    name: "商户凭据",
    environments: ["客户A", "生产"],
    schema_id: "model-a",
    schema_name: "商户模型",
    schema_version: 3,
  };
  const filters = {
    datasetId: "",
    category: "业务",
    tags: ["客户A", "生产"],
    schemaId: "model-a",
    includeExpired: false,
  };
  assert.equal(matchesFilters(current, filters), true);
  assert.equal(matchesFilters({ ...current, environments: ["客户A", "测试"] }, filters), false);
  assert.equal(matchesFilters({ ...current, schema_id: "model-b" }, filters), false);
  assert.equal(matchesFilters({ ...current, category_path: "业务2/支付" }, filters), false);
  assert.deepEqual(datasetEnvironments({ ...current, environments: [] }), []);
  assert.deepEqual(datasetEnvironments(dataset), ["正式"]);
  assert.equal(datasetLabel(current), "商户凭据 · 业务/支付 · 客户A / 生产");
  assert.match(datasetMarkdown(current), /商户模型 · v3/);
  assert.match(recordMarkdown(record, current), /商户模型 · v3/);
  assert.match(datasetMarkdown({ ...current, description: "" }), /暂无数据集说明/);
  const duplicate = { ...current, id: "other" };
  assert.notEqual(
    datasetChoiceLabel(current, [current, duplicate]),
    datasetChoiceLabel(duplicate, [current, duplicate]),
  );
});

test("tag filters preserve literal punctuation and legacy whitespace and do not split names", () => {
  const label = " 客户A,区域 / 主站;备站 ";
  const current = { ...dataset, environments: [label, "生产"] };
  const filters = { datasetId: "", category: "", schemaId: "", tags: [label, "生产"], includeExpired: false };
  assert.equal(matchesFilters(current, filters), true);
  assert.equal(matchesFilters(current, { ...filters, tags: [label.trim()] }), false);
  assert.equal(matchesFilters(current, { ...filters, tags: ["客户A", "区域"] }), false);
});
