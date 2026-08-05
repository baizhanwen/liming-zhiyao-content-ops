# 分析任务与 Python 服务契约

## 边界

Cloudflare Web/API 负责身份、权限、D1 业务记录、R2 私有媒体和任务控制。Python 服务负责媒体下载、FFmpeg、ASR、OCR、关键帧、确定性统计和模型适配。

网页请求只能创建任务，不能同步执行下载、转写、OCR 或大模型分析。

## 任务输入

分析任务通过 `analysis_jobs.video_id` 关联 `videos`：

- `source_type=url`：`videos.source_url` 是经过校验的抖音公开链接；
- `source_type=upload`：`videos.media_asset_id` 指向 `media_assets`，实际字节位于 R2；
- `idempotency_key` 在公司范围内唯一；
- Python 服务不得信任任务中额外传入的公司或项目 ID，必须以 D1 中视频归属为准。

## 状态机

```text
pending → queued → downloading/processing
→ transcribing → extracting → analyzing → completed
```

任意执行阶段可以进入 `failed` 或 `cancelled`。只有 `failed` 和 `cancelled` 可以由有写权限的成员重置为 `pending`。每次重试增加 `retry_count`，清空旧错误，但不删除已完成的阶段产物。

## 阶段产物

| 阶段 | D1 | R2 |
|---|---|---|
| 入库 | `videos`、`analysis_jobs` | 原始上传媒体 |
| 媒体处理 | 阶段进度、媒体元数据 | 音频、规范化视频 |
| 转写 | `video_transcripts` | 可选字幕文件 |
| 画面提取 | 关键帧元数据 | 关键帧图片 |
| 结构分析 | `video_analyses` | 可选中间结果 |
| 指标回收 | `video_metric_snapshots` | 无 |

每个产物都必须带 `organization_id`、`project_id` 和 `video_id`。R2 对象键必须使用：

```text
organizations/{organization_id}/projects/{project_id}/...
```

## 结果约束

- 统计值由 Python 计算，模型只解释结果；
- 转写片段包含开始、结束时间和文本；
- 分析 JSON 保存 `schema_version`、证据时间点和置信度；
- 模型结果通过结构校验后才能标记 `completed`；
- 失败记录稳定错误码和可读错误信息，不保存模型密钥或第三方临时媒体地址；
- 完成写入和任务状态切换必须具备幂等性。

## 后续实现入口

下一施工批次将增加服务端任务领取、阶段心跳、阶段结果提交和超时回收接口，并使用单独的服务凭据，不复用浏览器登录身份。
