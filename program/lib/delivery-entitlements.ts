export const deliveryPlan = {
  deliveryMode: false,
  code: "scale",
  name: "完整开发版",
  features: {
    videoAnalysis: true,
    wechatImages: false,
    insights: true,
  },
  quotas: {
    projectQuota: 100,
    memberQuota: 250,
    monthlyAnalysisQuota: 5_000,
    monthlyModelCallQuota: 20_000,
    storageQuotaBytes: 200 * 1024 ** 3,
    retentionDays: 730,
    failedJobAlertThreshold: 10,
  },
} as const;

export type DeliveryFeature = keyof typeof deliveryPlan.features;

export function deliveryFeatureEnabled(feature: DeliveryFeature) {
  return deliveryPlan.features[feature];
}
