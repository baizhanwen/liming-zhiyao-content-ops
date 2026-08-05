# GitHub 开源工具采用地图

更新时间：2026-08-05

这份清单用于决定“学习、封装调用、以后评估”三种关系。项目不会直接复制第三方产品，也不会为了追逐热度替换已经稳定的租户、任务或数据模型。

## 采用原则

1. 优先选择官方仓库、许可证清晰、近期仍发布版本的项目；
2. 视频平台、模型和外部服务必须通过适配器隔离；
3. 核心业务记录仍保存在 D1，媒体和分析产物仍保存在 R2；
4. 新依赖必须固定兼容版本、保存许可证，并通过回归测试；
5. 模型代码许可证与模型权重许可证分开检查；
6. 不把单一公开视频下载工具当作稳定的平台接口。

## 阶段 1：租户、项目和成员

| 工具 | 关系 | 用途 |
|---|---|---|
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | 已采用 | D1/SQLite 类型化表结构和迁移；继续保留。 |
| [Zod](https://github.com/colinhacks/zod) | 已采用 | 校验内容生产输入、口播稿生产包和多模型结构化输出；后续逐步覆盖其他 API。 |
| [Playwright](https://github.com/microsoft/playwright) | 验收采用 | 登录、邀请、跨租户隔离、角色权限和移动端关键路径测试。 |

不引入另一套应用登录框架：当前站点身份由托管平台提供，服务端继续执行项目授权。

## 阶段 2：视频分析闭环

| 工具 | 关系 | 用途 |
|---|---|---|
| [FFmpeg](https://github.com/FFmpeg/FFmpeg) | 已采用 | 媒体探测、音轨标准化和图片提取。 |
| [FunASR](https://github.com/modelscope/FunASR) | 已接入并真实验收 | `paraformer-zh` 中文 ASR、句级时间轴、VAD、标点；已用官方中文音频验证，模型许可证单独复核。 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 已接入并真实验收 | `PP-OCRv5_mobile_det/rec` 短视频字幕和场景文字 OCR；已用真实图片推理验证。 |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | 已接入并真实验收 | 镜头切分和代表性关键帧选择；已用 FFmpeg 合成转场视频验证。 |
| [Instructor](https://github.com/567-labs/instructor) | 已接入并契约验收 | Pydantic 结构校验、失败重试和可追溯报告；真实 DeepSeek/GLM 调用等待项目密钥。 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 条件采用 | 公开视频解析实验入口；抖音兼容性不能承诺，上传文件是保底入口。 |

## 阶段 3：知识库与内容生产

| 工具 | 关系 | 用途 |
|---|---|---|
| [Tiptap](https://github.com/ueberdosis/tiptap) | 计划评估 | 口播稿和生产包的结构化编辑器；只使用 MIT 核心扩展。 |
| [Langfuse](https://github.com/langfuse/langfuse) | 后期评估 | 提示词版本、模型 Trace、数据集和效果评估；首版仍以项目自己的调用记录为准。 |

首版知识量较小时先使用 D1 查询，不提前引入独立向量数据库。确认检索规模和召回指标后再决定向量服务。

## 阶段 4：审核、日历和协作

| 工具 | 关系 | 用途 |
|---|---|---|
| [Tiptap](https://github.com/ueberdosis/tiptap) | 计划评估 | 稿件批注、结构化节点和版本快照。 |
| [Yjs](https://github.com/yjs/yjs) | 条件评估 | 只有确认需要多人实时同编时才引入 CRDT；普通审核流不需要。 |

评论、审核状态、版本和发布记录仍由项目自己的 D1 状态机管理。

阶段 4 已使用项目自己的版本快照、审核状态机和普通评论完成首版协作闭环，因此暂不引入 Tiptap 或 Yjs。只有出现结构化行内批注或多人实时同编的明确需求时再评估，避免为普通审核流增加同步复杂度。

## 阶段 5：数据闭环与报告

| 工具 | 关系 | 用途 |
|---|---|---|
| [Apache ECharts](https://github.com/apache/echarts) | 已采用 | 账号趋势、平台构成、互动率和周/月报可视化；指标由服务端先计算。 |
| [Papa Parse](https://github.com/mholt/PapaParse) | 已采用 | 浏览器本地解析标准 CSV、字段映射和导入预览；服务器执行第二次严格校验。 |
| [Polars](https://github.com/pola-rs/polars) | 批量分析时采用 | 数据规模超过在线请求适合范围后，再用于 Python 批量快照、分组统计和时间序列加工。 |

统计口径仍由项目代码冻结并回归测试，不让图表库或大模型决定指标含义。

## 阶段 6：稳定运行与商业化

| 工具 | 关系 | 用途 |
|---|---|---|
| [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js) | 计划评估 | Web/API Trace、指标和日志关联。 |
| [OpenTelemetry Python](https://github.com/open-telemetry/opentelemetry-python) | 计划评估 | 分析 Worker、FFmpeg、ASR、OCR 和模型调用耗时与错误率。 |
| [Playwright](https://github.com/microsoft/playwright) | 持续采用 | 发布前核心业务回归和故障 Trace。 |

监控、支付、邮件和短信等外部能力应先确认供应商、隐私与费用，再决定托管服务或开源自建。
