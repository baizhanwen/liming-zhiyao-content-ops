import {commitScopedMutation,ScopedMutationStatusUnknownError,type ScopedMutationOptions} from './scoped-mutation';
export {nextWriteTimestamp} from './scoped-mutation';

export function referenceWriteUnknown() {
  return new ScopedMutationStatusUnknownError('REFERENCE_WRITE_STATUS_UNKNOWN','暂时无法确认资料或策略是否已保存。请恢复连接后刷新列表、核对版本与状态，勿连续重复提交；先复制尚未保存的填写内容。');
}
export function commitReferenceWrite(db:D1Database,options:Omit<ScopedMutationOptions,'accessMessage'|'unknownError'>) {
  return commitScopedMutation(db,{...options,accessMessage:'登录状态或企业空间权限已改变，本次资料操作未保存。请刷新确认权限，先复制尚未保存的填写内容。',unknownError:referenceWriteUnknown});
}
export function readReferenceRevision(payload:Record<string,unknown>) {
  return Number.isSafeInteger(payload.expectedVersion)&&Number(payload.expectedVersion)>0
    &&typeof payload.expectedUpdatedAt==='string'&&payload.expectedUpdatedAt.trim()&&payload.expectedUpdatedAt.length<=100
    ? {version:Number(payload.expectedVersion),updatedAt:payload.expectedUpdatedAt}:null;
}
