import type { WorkTask, WorkTaskAction, WorkTaskStatus } from "./work-tasks";

export const workProgressStatuses = {
  pending: "待开始", in_progress: "进行中", waiting: "等待协作", completed: "已完成", cancelled: "已取消",
} satisfies Record<WorkTaskStatus, string>;

export const workProgressTypes = {
  custom: "通用任务", video_analysis: "视频分析", topic: "选题生产", content: "内容生产", review: "内容审核", publish: "作品发布",
} satisfies Record<WorkTask["task_type"], string>;

export const workProgressPriorities = {
  low: "低", normal: "普通", high: "重要", urgent: "紧急",
} satisfies Record<WorkTask["priority"], string>;

export const workProgressActions = {
  created: "创建任务", report: "填报进度", reopen: "重新打开", cancel: "取消任务", complete: "完成任务", count: "更新业务数量",
} satisfies Record<WorkTaskAction, string>;
