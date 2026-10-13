import { commitScopedMutation, ScopedMutationStatusUnknownError, type ScopedMutationOptions } from "./scoped-mutation";
export { nextWriteTimestamp } from "./scoped-mutation";

export function commitContentWorkflowWrite(db: D1Database, options: Omit<ScopedMutationOptions,"accessMessage"|"unknownError">) {
  return commitScopedMutation(db,{...options,
    accessMessage:"登录状态或企业空间权限已改变，本次协作操作未保存。请刷新确认后再操作。",
    unknownError:()=>new ScopedMutationStatusUnknownError("CONTENT_OPERATION_STATUS_UNKNOWN","暂时无法确认审核、发布、排期或评论操作是否已保存。请恢复服务并刷新当前内容核对，勿连续重复提交。"),
  });
}
