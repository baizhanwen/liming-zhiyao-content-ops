import type { ProductPublic } from "./contracts";

export type FirstVideoProduct = {
  id: string; name: string; sku: string; status: string; currentVersion: number; versionId: string;
  confirmedAt: string | null; publicData: ProductPublic | null;
  evidenceCount: number; readyEvidenceCount: number; readyClaimIds: string[];
  ready: boolean; problems: string[];
};
export type FirstVideoTask = {
  id: string; title: string; status: string; productId: string; productVersionId: string;
  currentVersion: number; versionId: string | null; hasDraft: boolean;
  pendingConfirmationCount: number | null; readyForFilming: boolean;
};
export type FirstVideoGuideData = {
  observedAt: string;
  settings: { enabled: number; revision: number; max_concurrent: number; monthly_call_limit: number };
  canManage: boolean;
  products: FirstVideoProduct[];
  selectedProductId: string | null;
  selectedProduct: FirstVideoProduct | null;
  tasks: FirstVideoTask[];
  strategy: { ready: boolean; positioning: string; targetAudience: string; styleNotes: string };
  methods: { counts: Record<"hook" | "visual" | "structure" | "sop", number>; total: number; ready: boolean };
};
export type FirstVideoGuideStep = "product" | "evidence" | "create";
export type FirstVideoStepState = "unknown" | "pending" | "current" | "complete";

/** Readiness follows persisted facts. A failed or unfinished read is unknown. */
export function deriveFirstVideoReadiness(data: FirstVideoGuideData | null | undefined) {
  const definitions = [
    { id: "product" as const, label: "准备商品" },
    { id: "evidence" as const, label: "确认卖点与依据" },
    { id: "create" as const, label: "生成与拍摄" },
  ];
  if (!data) return {
    state: "unknown" as const, enabled: false, productSaved: false, productReady: false,
    setupReady: false, draftReady: false, filmingReady: false, completed: false,
    suggestedStep: "product" as FirstVideoGuideStep,
    steps: definitions.map(step => ({ ...step, status: "unknown" as FirstVideoStepState })),
  };
  const selected = data.selectedProduct;
  const matchingTasks = selected ? data.tasks.filter(task => task.productId === selected.id && task.productVersionId === selected.versionId && task.status !== "archived") : [];
  const productSaved = Boolean(selected), productReady = Boolean(selected?.ready);
  const setupReady = Boolean(data.settings.enabled && data.strategy.ready && data.methods.ready);
  const draftReady = matchingTasks.some(task => task.hasDraft);
  const filmingReady = productReady && setupReady && matchingTasks.some(task => task.hasDraft && task.readyForFilming);
  const suggestedStep: FirstVideoGuideStep = !productSaved ? "product" : !productReady ? "evidence" : "create";
  const done = { product: productSaved, evidence: productReady, create: filmingReady };
  return {
    state: "known" as const, enabled: Boolean(data.settings.enabled), productSaved, productReady,
    setupReady, draftReady, filmingReady, completed: filmingReady, suggestedStep,
    steps: definitions.map(step => ({ ...step, status: (done[step.id] ? "complete" : step.id === suggestedStep ? "current" : "pending") as FirstVideoStepState })),
  };
}
