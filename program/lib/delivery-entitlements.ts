export const deliveryPlan = {
  deliveryMode: false,
  code: "team",
  name: "开发完整版",
  features: {
    videoAnalysis: true,
    wechatImages: false,
    insights: true,
  },
  quotas: {
    projectQuota: 20,
    memberQuota: 50,
    monthlyAnalysisQuota: 500,
    monthlyModelCallQuota: 2_000,
    storageQuotaBytes: 20 * 1024 ** 3,
    retentionDays: 365,
    failedJobAlertThreshold: 3,
  },
} as const;

export type DeliveryFeature = keyof typeof deliveryPlan.features;

export function deliveryFeatureEnabled(feature: DeliveryFeature) {
  return deliveryPlan.features[feature];
}
