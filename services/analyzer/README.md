# Python 视频分析服务

分析服务与网站分开运行。网站负责身份、租户权限、D1、R2 和任务状态；本服务负责公开视频获取、FFmpeg、ASR、OCR、镜头检测、确定性统计与结构化模型调用。

当任务绑定了人工校正版转写时，Worker 会直接使用该版本并跳过 ASR，继续执行媒体规范化、关键帧/OCR、证据整理和结构化分析。这样可以修正口播识别错误，同时保留完整的画面分析结果和转写版本记录。

## 当前生产组合

- FFmpeg / ffprobe：媒体探测、16 kHz 单声道音轨和图片提取；
- FunASR：使用 `paraformer-zh` 完成中文语音转写、句级时间轴、VAD 与标点；
- PaddleOCR：使用 `PP-OCRv5_mobile_det/rec` 识别短视频字幕和场景文字；
- PySceneDetect：按镜头变化选择关键帧，无法检出镜头时退回定时抽帧；
- Instructor + Pydantic：约束 DeepSeek、GLM 等 OpenAI 兼容模型的报告结构并自动重试；
- yt-dlp：实验性的公开视频解析适配器；平台规则变化时允许失败，上传文件始终是可靠入口。

具体模型通过适配器注入。统计数字不交给大模型估算，模型证据必须逐字引用 ASR 或 OCR 原文。

## 安装

```powershell
cd services/analyzer
python -m pip install -e ".[media]"
```

系统还需安装 `ffmpeg` 和 `ffprobe`。FunASR、PaddleOCR 的模型文件会在首次使用时下载；生产环境应固定模型版本并预热缓存。

## 配置

Worker 需要以下环境变量：

- `ANALYZER_BASE_URL`
- `ANALYZER_SERVICE_TOKEN`
- `ANALYZER_WORKER_ID`
- `ANALYZER_LLM_API_KEY`
- `ANALYZER_LLM_BASE_URL`
- `ANALYZER_LLM_MODEL`
- `ANALYZER_LLM_PROVIDER`
- `ANALYZER_VISION_API_KEY`：MiniMax Token Plan Key（`sk-cp` 开头），与其他文本模型密钥隔离
- `ANALYZER_VISION_BASE_URL`：国内 Token Plan 使用 `https://api.minimaxi.com`，不要附加 `/v1`
- `ANALYZER_VISION_MODEL`：固定填写 `understand_image`；旧的 `MiniMax-M3` 会被识别为文本模型并改走 Token Plan MCP
- `ANALYZER_VISION_PROVIDER`：推荐 `minimax-token-plan`；Worker 通过官方 MCP stdio 服务处理带帧号和时间码的联系表，OCR 不会冒充画面理解
- `ANALYZER_VISION_CONCURRENCY`：视觉批次并发数，默认 `2`，允许 `1`～`3`；建议稳定运行后再从 `2` 调到 `3`
- `ANALYZER_YTDLP_COOKIES_FROM_BROWSER`：可选，公开视频链接建议设置为 `edge`、`chrome` 或 `firefox`；也可使用 `edge:Default` 指定配置文件。Worker 只在本机读取浏览器 Cookie，不会把 Cookie 上传到网站或数据库。
- `ANALYZER_ASR_MODEL`，默认 `paraformer-zh`；可切换 `iic/SenseVoiceSmall`
- ANALYZER_ASR_FALLBACK_MODEL，默认 iic/SenseVoiceSmall；仅在末尾转写异常稀疏且能找回更多文字时延迟调用，设为空可关闭
- `ANALYZER_ASR_DEVICE`，默认 `cpu`
- `ANALYZER_PADDLE_OCR_DETECTION_MODEL`，默认 `PP-OCRv5_mobile_det`
- `ANALYZER_PADDLE_OCR_RECOGNITION_MODEL`，默认 `PP-OCRv5_mobile_rec`
- `ANALYZER_PADDLE_MODEL_SOURCE`，默认 `bos`（Paddle 官方 BOS 模型源，Windows 本地交付推荐）
- `ANALYZER_MODEL_CACHE`，建议指向 Worker 的持久化模型卷；Windows 未配置时自动使用纯英文的 `%LOCALAPPDATA%/LimingZhiyao/model-cache`

Windows 下 Paddle 原生推理层可能无法读取含中文字符的模型路径，因此模型缓存不要放在中文目录。CPU 推理默认关闭 oneDNN，以规避当前 PaddlePaddle 对 PP-OCRv5 PIR 模型的算子兼容问题。

单次领取任务：

```powershell
python -m liming_analyzer --once
```

持续运行：

```powershell
python -m liming_analyzer
```

## 数据与安全边界

- Worker 只能使用独立服务令牌访问内部接口；
- 源媒体、字幕和关键帧均通过租约绑定的接口读写；
- Worker 不持有 D1 或 R2 管理凭据；
- 任务执行期间持续发送心跳，失去租约后不能提交产物；
- 关键帧、字幕、公开元数据和指标都由网站重新按公司、项目与视频校验。

## 验证

```powershell
python -m unittest discover -s tests -v
```

自动测试使用注入的假模型，不下载大模型。正式验收仍需使用有授权的真实短视频样片和有效的模型密钥。
