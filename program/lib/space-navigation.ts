export const AUTHORIZED_METHOD_LIBRARY_VISIBLE = false;

export type SpaceTab = "overview" | "knowledge" | "strategy" | "memory" | "method";
export type SpaceSearchParams = Record<string, string | string[] | undefined>;

export function spaceSearchParams(query: SpaceSearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}

export const spaceProjectStatus: Record<string, string> = {
  draft: "筹备中",
  active: "运行中",
  paused: "已暂停",
  archived: "已归档",
};
