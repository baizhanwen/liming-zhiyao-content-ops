# 分析任务与 Python 服务契约

## 边界

Cloudflare Web/API 负责身份、权限、D1 业务记录、R2 私有媒体和任务控制。Python 服务负责媒体下载、FFmpeg、ASR、OCR、关键帧、确定性统计和模型适配。网页请求只创建任务，不同步执行重型分析。

Python 服务使用独立的 `ANALYZER_SERVICE_TOKEN`，不得复用浏览器用户身份。正式值通过 Sites 运行时配置管理；仓库只保留 `.env.example` 中的占位说明。

## 领取与租约

1. `POST /api/internal/analysis-jobs/claim` 原子领取最早的待处理任务，或接管租约已经过期的活动任务。
2. 返回的 `version` 是乐观并发版本。后续心跳和结果请求必须同时携带 `workerId` 与 `version`。
3. `POST /api/internal/analysis-jobs/{jobId}/heartbeat` 续租并推进合法状态；进度不得回退。
4. 每次有效写入都会增加版本。租约过期、租约所有者不符或版本冲突时，Worker 必须停止当前任务，不能强行覆盖。

领取接口只会选择 `analysis_jobs` 与 `videos` 的公司、项目归属完全一致的记录。上传来源返回 R2 对象键和媒体元数据；链接来源返回已校验的公开抖音链接。

上传媒体的实际字节通过 `GET /api/internal/analysis-jobs/{jobId}/source` 读取。接口同时校验服务令牌、`x-worker-id`、租约所有者和租约有效期，并支持范围请求。浏览器使用独立的项目成员鉴权媒体接口，不得复用服务令牌。

## 状态机

```text
pending → queued → downloading/processing
→ transcribing → extracting → analyzing → completed
```

活动阶段可以进入 `failed` 或 `cancelled`。只有 `failed` 和 `cancelled` 可由具有项目写权限的成员重置为 `pending`。重试会清除旧租约、心跳与结果幂等键，但保留历史事件。

## 结果回传

- `POST /api/internal/analysis-jobs/{jobId}/complete` 仅接受 `analyzing` 状态，并在一个 D1 批次中写入转写、结构化分析、视频状态和任务事件。
- `POST /api/internal/analysis-jobs/{jobId}/fail` 记录稳定错误码与可读错误信息。
- 两个端点都要求不可复用的 `resultKey`。相同任务和相同键重复提交会返回幂等成功，不会重复创建产物。
- 结构化报告与转写分别限制为约 1 MB；置信度使用 0–100 的整数。
- 产物的 `organization_id`、`project_id` 和 `video_id` 只能从已校验的任务与视频关联中派生，不能信任 Worker 额外传入的租户 ID。

## 阶段产物

| 阶段 | D1 | R2 |
|---|---|---|
| 入库 | `videos`、`analysis_jobs` | 原始上传媒体 |
| 媒体处理 | 进度、租约与事件 | 音频、规范化视频 |
| 转写 | `video_transcripts` | 可选字幕文件 |
| 画面提取 | 关键帧元数据 | 关键帧图片 |
| 结构分析 | `video_analyses` | 可选中间结果 |
| 指标回收 | `video_metric_snapshots` | 无 |

所有 R2 对象键必须使用 `organizations/{organization_id}/projects/{project_id}/...` 前缀。

## Python 客户端

`services/analyzer/liming_analyzer/api_client.py` 封装领取、心跳、完成和失败请求；`worker.py` 提供单次执行与持续轮询骨架。当前尚未绑定具体 FFmpeg、ASR、OCR 或模型供应商，后续适配器只需实现处理函数，并在耗时阶段持续调用心跳回调。

`AnalysisPipeline` 已固定媒体获取、规范化、ASR、关键帧/OCR、证据整理和结构分析的合法阶段顺序。FFmpeg 使用无 Shell 的参数数组执行；ASR、OCR、抖音公开视频解析器和结构化模型均通过协议注入。未配置供应商时任务不得伪造完成结果。

用户侧 `analysis/{videoId}` 详情页通过公司与项目权限重新读取最新转写、分析、指标快照和任务事件。上传媒体保持 R2 私有并通过成员鉴权流式播放；时间轴与报告证据可以定位到媒体时间点。
