import type { Dataset, Field, PublicField, VaultRecord } from "./types";

export function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0);
}

export function valueText(value: unknown, pretty = false): string {
  return typeof value === "object" ? JSON.stringify(value, null, pretty ? 2 : undefined) : String(value ?? "");
}

export function datasetLabel(dataset: Dataset): string {
  return `${dataset.category_path} · ${dataset.environment || "未设置环境"}`;
}

export function datasetChoiceLabel(dataset: Dataset, datasets: Dataset[]): string {
  const label = datasetLabel(dataset);
  if (datasets.filter((item) => datasetLabel(item) === label).length < 2) return label;
  // Only identical directory/environment pairs need a system-ID suffix.
  let size = 8;
  while (
    size < dataset.id.length &&
    datasets.some(
      (item) =>
        item.id !== dataset.id && datasetLabel(item) === label && item.id.slice(-size) === dataset.id.slice(-size),
    )
  )
    size++;
  return `${label} · ${dataset.id.slice(-size)}`;
}

function publicDefinitions(fields: Field[], searchOnly = false): Field[] {
  const zones = searchOnly ? ["indexes", "display"] : ["indexes", "display", "normal"];
  return fields.filter((field) => zones.includes(field.zone)).sort((a, b) => a.position - b.position);
}

function identifierKeys(record: VaultRecord, dataset: Dataset): string[] {
  const values = { ...record.indexes, ...record.display };
  const fields = publicDefinitions(dataset.fields, true);
  const present = (key: string) => fields.some((field) => field.source_key === key) && hasValue(values[key]);
  let keys = (dataset.display_config.identifier_fields || []).filter(present);
  if (!keys.length && dataset.identity_fields.length && dataset.identity_fields.every(present))
    keys = dataset.identity_fields;
  return keys;
}

export function recordIdentity(record: VaultRecord, dataset?: Dataset): string {
  if (!dataset) return `记录 #${record.id}`;
  const values = { ...record.indexes, ...record.display };
  const keys = identifierKeys(record, dataset);
  return keys.length
    ? keys
        .map(
          (key) =>
            `${dataset.fields.find((field) => field.source_key === key)?.display_name || key}：${valueText(values[key])}`,
        )
        .join(" · ")
    : `记录 #${record.id}`;
}

export function publicFields(record: VaultRecord, dataset: Dataset, detail = false): PublicField[] {
  const matched = new Set(record.matched_fields || []);
  const main = {
    ...record.indexes,
    ...record.display,
    ...(detail ? record.normal : {}),
  };
  const supplement = detail
    ? record.supplement_records?.find((row) => !row.orphan)?.values || {}
    : { ...record.supplement?.indexes, ...record.supplement?.display };
  const result: PublicField[] = [];
  for (const [section, values, definitions] of [
    ["main", main, dataset.fields],
    ["supplement", supplement, dataset.supplement_fields],
  ] as const) {
    for (const field of publicDefinitions(definitions, !detail)) {
      const key = section === "supplement" ? `supplement.${field.source_key}` : field.source_key;
      if (!hasValue(values[field.source_key])) continue;
      result.push({
        key: `${section}:${field.source_key}`,
        label: field.display_name || field.source_key,
        value: values[field.source_key],
        section,
        matched: matched.has(key),
      });
    }
  }
  return result;
}

export function summary(record: VaultRecord, dataset: Dataset, compact = false): string {
  const fields = publicFields(record, dataset);
  const identifiers = new Set(identifierKeys(record, dataset).map((key) => `main:${key}`));
  const defaults = dataset.list_fields.length
    ? dataset.list_fields
        .filter((field) => field.visible)
        .sort((a, b) => a.position - b.position)
        .map((field) => `main:${field.source_key}`)
    : fields.filter((field) => field.section === "main").map((field) => field.key);
  const keys = [
    ...new Set([
      ...fields.filter((field) => field.matched).map((field) => field.key),
      ...defaults,
      ...fields
        .filter(
          (field) =>
            field.section === "supplement" &&
            dataset.supplement_fields.some(
              (definition) => `supplement:${definition.source_key}` === field.key && definition.zone === "display",
            ),
        )
        .map((field) => field.key),
    ]),
  ];
  return keys
    .flatMap((key) => {
      const field = fields.find((candidate) => candidate.key === key);
      if (compact && field && !field.matched && identifiers.has(field.key)) return [];
      return field
        ? [
            `${field.section === "supplement" ? "附表 · " : ""}${!compact || field.matched || field.section === "supplement" ? `${field.label}：` : ""}${valueText(field.value).replace(/\s+/g, " ")}`,
          ]
        : [];
    })
    .slice(0, 2)
    .join(" · ");
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+.!|<>~-]/g, "\\$&");
}

export function valueBlock(value: unknown): string {
  const text = valueText(value, true);
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function blockValue(value: unknown): boolean {
  return typeof value === "object" || /[\r\n]/.test(valueText(value));
}

export function valueMarkdown(value: unknown): string {
  return blockValue(value) ? valueBlock(value) : escapeMarkdown(valueText(value));
}

function fieldRowsMarkdown(fields: PublicField[]): string {
  const parts: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) parts.push(lines.join("  \n"));
    lines = [];
  };
  for (const field of fields) {
    const label = `**${escapeMarkdown(field.label)}${field.matched ? " · 命中" : ""}**`;
    if (blockValue(field.value)) {
      flush();
      parts.push(`${label}\n\n${valueMarkdown(field.value)}`);
    } else {
      lines.push(`${label}\u2002${valueMarkdown(field.value)}`);
    }
  }
  flush();
  return parts.join("\n\n");
}

export function recordMarkdown(record: VaultRecord, dataset: Dataset, detail = false): string {
  const fields = publicFields(record, dataset, detail);
  const intro = `### ${escapeMarkdown(recordIdentity(record, dataset))}\n\n${escapeMarkdown(datasetLabel(dataset))}${record.expired ? " · 已过期" : ""}`;
  return [
    intro,
    ...(["main", "supplement"] as const).map((section) => {
      const rows = fields.filter((field) => field.section === section);
      if (!rows.length) return "";
      return `${section === "supplement" ? "---\n\n#### 附表补充\n\n" : ""}${fieldRowsMarkdown(rows)}`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function categories(datasets: Dataset[]): string[] {
  const paths = new Set<string>();
  for (const dataset of datasets) {
    const parts = dataset.category_path.split("/");
    for (let size = 1; size <= parts.length; size++) paths.add(parts.slice(0, size).join("/"));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
