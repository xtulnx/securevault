export type Values = Record<string, unknown>;

export interface Field {
  source_key: string;
  display_name: string;
  zone: string;
  position: number;
}

export interface Dataset {
  id: string;
  category_path: string;
  environment: string | null;
  fields: Field[];
  supplement_fields: Field[];
  identity_fields: string[];
  list_fields: {
    source_key: string;
    display_name: string;
    position: number;
    visible: boolean;
    format: string;
  }[];
  display_config: { identifier_fields?: string[]; density?: string };
  description: string;
}

export interface VaultRecord {
  id: string;
  dataset_id: string;
  category: string;
  environment: string | null;
  indexes?: Values;
  display?: Values;
  normal?: Values;
  expired?: boolean;
  matched_fields?: string[];
  supplement?: {
    id: string;
    indexes?: Values;
    display?: Values;
    field_labels?: Record<string, string>;
  };
  supplement_records?: { id: string; orphan: boolean; values: Values }[];
}

export interface SearchResult {
  records: VaultRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface Filters {
  datasetId: string;
  category: string;
  environment: string;
  includeExpired: boolean;
}

export interface PublicField {
  key: string;
  label: string;
  value: unknown;
  section: "main" | "supplement";
  matched: boolean;
}
