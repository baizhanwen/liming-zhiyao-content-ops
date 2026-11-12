import contract from "../services/analyzer/liming_analyzer/resources/content-report-contract.v1.json" with { type: "json" };

export const CONTENT_REPORT_MAX_UTF16_UNITS = contract.report_max_utf16_units;
export const CONTENT_EVIDENCE_REGISTRY_MAX_ENTRIES = contract.evidence_registry_max_entries;
const retiredDimensions = new Set<string>(contract.retired_dimension_ids);
export const isActiveAnalysisDimension = (id: string) => !retiredDimensions.has(id);
