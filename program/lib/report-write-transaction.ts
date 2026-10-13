import { commitScopedMutation, ScopedMutationStatusUnknownError, type ScopedMutationOptions } from "./scoped-mutation";
export { nextWriteTimestamp as nextReportVersion } from "./scoped-mutation";

export class ReportWriteStatusUnknownError extends ScopedMutationStatusUnknownError {
  constructor() { super("REPORT_WRITE_STATUS_UNKNOWN","暂时无法确认报告操作是否已保存。请恢复服务并刷新报告列表核对，请勿连续生成或定稿。"); }
}

export function commitReportWrite(db: D1Database, options: Omit<ScopedMutationOptions,"accessMessage"|"unknownError"|"targetId"> & { reportId: string }) {
  return commitScopedMutation(db,{...options,targetId:options.reportId,accessMessage:"登录状态或企业空间权限已改变，本次报告操作未保存。请刷新确认后再操作。",unknownError:()=>new ReportWriteStatusUnknownError()});
}
