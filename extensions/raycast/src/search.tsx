import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  Keyboard,
  List,
  getPreferenceValues,
  openExtensionPreferences,
  useNavigation,
} from "@raycast/api";
import { useMemo, useState } from "react";
import { Configuration, VaultClient, VaultError, recordUrl } from "./client";
import {
  categories,
  datasetChoiceLabel,
  datasetLabel,
  escapeMarkdown,
  publicFields,
  recordIdentity,
  recordMarkdown,
  summary,
  valueBlock,
  valueMarkdown,
  valueText,
} from "./presentation";
import type { Dataset, Filters, PublicField, VaultRecord } from "./types";
import { useResource } from "./use-resource";

const emptyFilters: Filters = {
  datasetId: "",
  category: "",
  environment: "",
  includeExpired: false,
};

function accessDenied(error?: VaultError): boolean {
  return Boolean(error && [401, 403, 423].includes(error.status || 0));
}

export default function Command() {
  const connection = useMemo(() => {
    try {
      return { client: new VaultClient(getPreferenceValues<Configuration>()) };
    } catch (error) {
      return { error: error as VaultError };
    }
  }, []);
  return connection.client ? (
    <Search client={connection.client} />
  ) : (
    <Detail
      markdown={escapeMarkdown(connection.error?.message || "配置无效")}
      actions={
        <ActionPanel>
          <Action title="打开扩展设置" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

function ConnectionActions({ client, refresh }: { client: VaultClient; refresh: () => void }) {
  return (
    <>
      <Action title="刷新" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={refresh} />
      <Action.Push title="检查连接与授权" icon={Icon.Info} target={<ConnectionCheck client={client} />} />
      <Action.OpenInBrowser title="打开 SecureVault" url={client.base.toString()} />
      <Action title="扩展设置" icon={Icon.Gear} onAction={openExtensionPreferences} />
    </>
  );
}

function ConnectionCheck({ client }: { client: VaultClient }) {
  const connection = useResource("connection", (signal) => client.datasets(signal));
  const result = connection.loading
    ? "正在检查…"
    : connection.error
      ? `${connection.error.status ? `HTTP ${connection.error.status}\n\n` : ""}${escapeMarkdown(connection.error.message)}`
      : connection.value?.length
        ? `连接成功，当前应用已授权 **${connection.value.length}** 个数据集。\n\n${connection.value.map((dataset) => `- ${escapeMarkdown(datasetLabel(dataset))}`).join("\n")}`
        : "连接成功，但当前应用没有可访问的数据集。请在 SecureVault → 接入应用 → 配置授权中勾选数据集并保存，然后刷新。";
  return (
    <Detail
      navigationTitle="检查连接与授权"
      isLoading={connection.loading}
      markdown={`# 连接与授权\n\n## 服务地址\n\n${valueBlock(client.base.toString())}\n\n## 检查结果\n\n${result}`}
      actions={
        <ActionPanel>
          <Action
            title="重新检查"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={connection.refresh}
          />
          <Action.OpenInBrowser title="打开 SecureVault" url={client.base.toString()} />
          <Action title="扩展设置" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

function FieldCopies({ fields }: { fields: PublicField[] }) {
  if (!fields.length) return null;
  return (
    <ActionPanel.Submenu title="复制字段" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd"], key: "c" }}>
      {(["main", "supplement"] as const).map((section) => (
        <ActionPanel.Section key={section} title={section === "main" ? "主要信息" : "附表补充"}>
          {fields
            .filter((field) => field.section === section)
            .map((field) => (
              <Action.CopyToClipboard key={field.key} title={field.label} content={valueText(field.value)} />
            ))}
        </ActionPanel.Section>
      ))}
    </ActionPanel.Submenu>
  );
}

function DescriptionAction({ dataset }: { dataset: Dataset }) {
  if (!dataset.description.trim()) return null;
  return (
    <Action.Push
      title="查看数据集说明"
      icon={Icon.Document}
      target={
        <Detail
          navigationTitle="数据集说明"
          markdown={`### ${escapeMarkdown(datasetLabel(dataset))}\n\n${valueBlock(dataset.description)}`}
        />
      }
    />
  );
}

function RecordView({ client, record, dataset }: { client: VaultClient; record: VaultRecord; dataset: Dataset }) {
  const detail = useResource(record.id, (signal) => client.detail(record.id, signal));
  const current = detail.value && {
    ...detail.value,
    matched_fields: record.matched_fields,
  };
  const fields = current ? publicFields(current, dataset, true) : [];
  const [selected, setSelected] = useState<string | null>(null);
  const active = fields.find((field) => field.key === selected) || fields[0];
  const actions = (field?: PublicField) => (
    <ActionPanel>
      {field && <Action.CopyToClipboard title="复制字段值" content={valueText(field.value)} />}
      <Action.OpenInBrowser
        title="在 SecureVault 中打开此记录"
        url={recordUrl(client.base, record.id)}
        shortcut={Keyboard.Shortcut.Common.Open}
      />
      <DescriptionAction dataset={dataset} />
      <ConnectionActions client={client} refresh={detail.refresh} />
    </ActionPanel>
  );
  return (
    <List
      isShowingDetail
      isLoading={detail.loading}
      navigationTitle={recordIdentity(record, dataset)}
      searchBarPlaceholder="查找字段名称…"
      onSelectionChange={setSelected}
    >
      <List.EmptyView
        title={detail.error ? "无法读取记录" : detail.loading ? "正在加载…" : "没有非敏感字段"}
        description={detail.error?.message}
        actions={actions()}
      />
      {(["main", "supplement"] as const).map((section) => (
        <List.Section key={section} title={section === "main" ? "主要信息" : "附表补充"}>
          {fields
            .filter((field) => field.section === section)
            .map((field) => (
              <List.Item
                key={field.key}
                id={field.key}
                title={field.label}
                subtitle={valueText(field.value).replace(/\s+/g, " ").slice(0, 80)}
                keywords={[field.key]}
                icon={section === "main" ? Icon.Document : Icon.Link}
                accessories={field.matched ? [{ tag: "命中" }] : []}
                detail={
                  <List.Item.Detail
                    markdown={active ? `### ${escapeMarkdown(active.label)}\n\n${valueMarkdown(active.value)}` : ""}
                  />
                }
                actions={actions(field)}
              />
            ))}
        </List.Section>
      ))}
    </List>
  );
}

function FilterForm({
  datasets,
  filters,
  apply,
}: {
  datasets: Dataset[];
  filters: Filters;
  apply: (filters: Filters) => void;
}) {
  const { pop } = useNavigation();
  const [values, setValues] = useState(filters);
  const candidates = datasets.filter(
    (dataset) =>
      (!values.category ||
        dataset.category_path === values.category ||
        dataset.category_path.startsWith(`${values.category}/`)) &&
      (!values.environment || dataset.environment === values.environment),
  );
  return (
    <Form
      navigationTitle="筛选 SecureVault"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="应用筛选"
            onSubmit={() => {
              apply(values);
              pop();
            }}
          />
          <Action
            title="清除筛选"
            icon={Icon.XMarkCircle}
            onAction={() => {
              apply(emptyFilters);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="category"
        title="目录"
        value={values.category}
        onChange={(category) => setValues({ ...values, category, datasetId: "" })}
      >
        <Form.Dropdown.Item value="" title="全部目录" />
        {categories(datasets).map((category) => (
          <Form.Dropdown.Item key={category} value={category} title={category} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="environment"
        title="环境"
        value={values.environment}
        onChange={(environment) => setValues({ ...values, environment, datasetId: "" })}
      >
        <Form.Dropdown.Item value="" title="全部环境" />
        {[
          ...new Set(
            datasets
              .map((dataset) => dataset.environment)
              .filter((value): value is string => value !== null && value !== ""),
          ),
        ]
          .sort()
          .map((environment) => (
            <Form.Dropdown.Item key={environment} value={environment} title={environment} />
          ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="dataset"
        title="数据集"
        value={values.datasetId}
        onChange={(datasetId) => setValues({ ...values, datasetId })}
      >
        <Form.Dropdown.Item value="" title="全部数据集" />
        {candidates.map((dataset) => (
          <Form.Dropdown.Item key={dataset.id} value={dataset.id} title={datasetChoiceLabel(dataset, candidates)} />
        ))}
      </Form.Dropdown>
      <Form.Checkbox
        id="includeExpired"
        title="过期记录"
        label="包含过期记录"
        value={values.includeExpired}
        onChange={(includeExpired) => setValues({ ...values, includeExpired })}
      />
    </Form>
  );
}

function Search({ client }: { client: VaultClient }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<string | null>(null);
  const metadata = useResource("datasets", (signal) => client.datasets(signal));
  const datasets = metadata.value || [];
  const key = JSON.stringify([query, filters, page, metadata.generation]);
  const results = useResource(
    key,
    (signal) => client.search(query, filters, page, signal),
    Boolean(metadata.value?.length),
    250,
  );
  const records = results.value?.records || [];
  const selectedRecord = records.find((record) => record.id === selection) || records[0];
  const preview = useResource(
    `${key}:${selectedRecord?.id || ""}`,
    (signal) => client.detail(selectedRecord!.id, signal),
    Boolean(selectedRecord),
  );
  const accessError = [results.error, preview.error].find(accessDenied);
  const error = metadata.error || accessError || results.error;
  const availableDatasets = metadata.error || accessError ? [] : datasets;
  const visibleRecords = error
    ? []
    : records.filter((record) => availableDatasets.some((dataset) => dataset.id === record.dataset_id));
  const filteredDatasets = availableDatasets.filter(
    (dataset) =>
      (!filters.category ||
        dataset.category_path === filters.category ||
        dataset.category_path.startsWith(`${filters.category}/`)) &&
      (!filters.environment || dataset.environment === filters.environment),
  );
  const datasetState =
    metadata.error || accessError
      ? { value: "__unavailable", title: "数据集加载失败" }
      : metadata.loading
        ? { value: "__loading", title: "正在加载数据集…" }
        : !datasets.length
          ? { value: "__empty", title: "未授权数据集" }
          : !filteredDatasets.length
            ? { value: "__filtered", title: "筛选范围内无数据集" }
            : undefined;
  const loading = metadata.loading || results.loading;
  const apply = (next: Filters) => {
    setFilters(next);
    setPage(1);
    setSelection(null);
  };
  const refresh = () => {
    setPage(1);
    setSelection(null);
    metadata.refresh();
    results.refresh();
    preview.refresh();
  };
  const activeFilters = [filters.category, filters.environment, filters.includeExpired ? "包含过期记录" : ""]
    .filter(Boolean)
    .join(" · ");
  const total = error ? 0 : results.value?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 40));
  const commonActions = (
    <>
      {availableDatasets.length > 0 && (
        <Action.Push
          title="筛选目录和环境"
          icon={Icon.Filter}
          shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
          target={<FilterForm datasets={datasets} filters={filters} apply={apply} />}
        />
      )}
      {(filters.datasetId || activeFilters) && (
        <Action title="清除筛选" icon={Icon.XMarkCircle} onAction={() => apply(emptyFilters)} />
      )}
      {page > 1 && (
        <Action
          title="上一页"
          icon={Icon.ArrowLeft}
          shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
          onAction={() => {
            setSelection(null);
            setPage(page - 1);
          }}
        />
      )}
      {page < pages && (
        <Action
          title="下一页"
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
          onAction={() => {
            setSelection(null);
            setPage(page + 1);
          }}
        />
      )}
      <ConnectionActions client={client} refresh={refresh} />
    </>
  );
  return (
    <List
      isShowingDetail={visibleRecords.length > 0}
      isLoading={loading || preview.loading}
      filtering={false}
      searchText={query}
      onSearchTextChange={(value) => {
        setQuery(value);
        setPage(1);
        setSelection(null);
      }}
      onSelectionChange={setSelection}
      actions={<ActionPanel>{commonActions}</ActionPanel>}
      searchBarPlaceholder="搜索名称、编号或附表信息…"
      searchBarAccessory={
        <List.Dropdown
          tooltip={metadata.error?.message || accessError?.message || `已授权 ${datasets.length} 个数据集`}
          value={datasetState?.value || filters.datasetId}
          storeValue={false}
          onChange={(datasetId) => {
            if (!datasetId.startsWith("__")) apply({ ...filters, datasetId });
          }}
        >
          {datasetState ? (
            <List.Dropdown.Item value={datasetState.value} title={datasetState.title} />
          ) : (
            <List.Dropdown.Item value="" title="全部数据集" />
          )}
          {filteredDatasets.map((dataset) => (
            <List.Dropdown.Item
              key={dataset.id}
              value={dataset.id}
              title={datasetChoiceLabel(dataset, filteredDatasets)}
            />
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView
        icon={error?.status === 423 ? Icon.Lock : error ? Icon.ExclamationMark : Icon.MagnifyingGlass}
        title={error ? "暂时无法搜索" : loading ? "正在加载…" : datasets.length ? "没有匹配的记录" : "尚未授权数据集"}
        description={
          error?.message ||
          (loading
            ? undefined
            : datasets.length
              ? "调整关键词或筛选条件后重试。"
              : "在 SecureVault 的接入应用中选择可见数据集，然后刷新。")
        }
        actions={<ActionPanel>{commonActions}</ActionPanel>}
      />
      {visibleRecords.length > 0 && (
        <List.Section
          title={`${total.toLocaleString()} 条记录`}
          subtitle={[`${page}/${pages} 页`, activeFilters].filter(Boolean).join(" · ")}
        >
          {visibleRecords.map((record) => {
            const dataset = datasets.find((item) => item.id === record.dataset_id);
            if (!dataset) return null;
            const selected = selectedRecord?.id === record.id;
            const full =
              selected && preview.value?.id === record.id
                ? { ...preview.value, matched_fields: record.matched_fields }
                : undefined;
            return (
              <List.Item
                key={record.id}
                id={record.id}
                title={recordIdentity(record, dataset)}
                subtitle={summary(record, dataset, true)}
                icon={record.expired ? Icon.Clock : Icon.Dot}
                detail={
                  <List.Item.Detail
                    markdown={
                      selected && preview.error
                        ? escapeMarkdown(preview.error.message)
                        : recordMarkdown(full || record, dataset, Boolean(full))
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="查看完整记录"
                      icon={Icon.Eye}
                      target={<RecordView client={client} record={record} dataset={dataset} />}
                    />
                    <FieldCopies fields={publicFields(full || record, dataset, Boolean(full))} />
                    <Action.OpenInBrowser
                      title="在 SecureVault 中打开此记录"
                      url={recordUrl(client.base, record.id)}
                      shortcut={Keyboard.Shortcut.Common.Open}
                    />
                    <DescriptionAction dataset={dataset} />
                    {commonActions}
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
