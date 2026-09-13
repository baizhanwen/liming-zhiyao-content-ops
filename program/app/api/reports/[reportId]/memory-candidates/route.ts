import { apiError } from "../../../../../lib/api-response";

export async function POST() {
  return apiError(
    "REPORT_RECOMMENDATION_NOT_MEMORY",
    "单期复盘建议不能直接保存为项目记忆。稳定经验需要至少两个作品或周期的证据，并在项目记忆中人工确认。",
    422,
  );
}
