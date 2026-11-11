# Python 视频分析服务

分析服务与网站分开运行。网站负责身份、租户权限、D1、R2 和任务状态；本服务负责公开视频获取、FFmpeg、ASR、OCR、镜头检测、确定性统计与结构化模型调用。

当任务绑定了人工校正版转写时，Worker 会直接使用该版本并跳过 ASR，继续执行媒体规范化、关键帧/OCR、证据整理和结构化分析。这样可以修正口播识别错误，同时保留完整的画面分析结果和转写版本记录。

## 当前生产组合

- FFmpeg / ffprobe：媒体探测、16 kHz 单声道音轨和图片提取；
- 本地转写：支持 faster-whisper 的独立模型缓存与真实片段时间轴；本次本机部署沿用原 lmzy 的 `small / zh / auto`。原 FunASR `paraformer-zh`、VAD 与标点路径继续兼容；
- PaddleOCR：使用 `PP-OCRv5_mobile_det/rec` 识别短视频字幕和场景文字；
- PySceneDetect：按镜头变化选择关键帧，无法检出镜头时退回定时抽帧；
- Instructor + Pydantic：约束 DeepSeek、GLM 等 OpenAI 兼容模型的报告结构并自动重试；
- Skill Collect 视频采集适配器：先解析官方公开页面，再按需使用独立匿名 Chromium 取得完整原片，保留目标 ID、完整字节覆盖、哈希、轨道与时长校验；平台限制导致获取失败时可上传文件。

抖音详情接口不返回视频信息、yt-dlp 提示 `Fresh cookies` 时，服务会回退到同一视频的公开移动分享页面。只读取页面中与原视频 ID 一致的播放器数据；临时空响应最多再请求一次，仍不可访问时保留访问失败提示。自动 Cookie 同步不能保证平台始终允许下载。

具体模型通过适配器注入。统计数字不交给大模型估算，模型证据必须逐字引用 ASR 或 OCR 原文。

转写时间轴由 `asr_timeline.py` 校验原始词序列与逐词时间戳后重建，避免中英文、数字的标点分词差异在长视频中累积错位。标点结果只有在完整保留识别词时才采用；缺少可靠对齐且句级结果丢字时会报错，不把错位字幕当作成功结果。清理仅合并时间重叠的重复识别，保留不同时间实际说出的重复口语。该校验保证文字与识别时间戳对应，不代表模型已正确识别所有口音、专名或多人重叠语音。

AI 口播校正最多执行两轮。确认响应因输出 Token 上限截断时，重试将该批次额度提高到原来的两倍且至少 2048 Token，但不超过配置的单次输出上限；已经达到上限时停止同额度重试并保留失败原因。其他错误仍使用原额度，完整性与忠实度校验继续生效。

## 安装

```powershell
cd services/analyzer
python -m pip install -e ".[media]"
```

系统还需安装 `ffmpeg` 和 `ffprobe`。FunASR、PaddleOCR 的模型文件会在首次使用时下载；生产环境应固定模型版本并预热缓存。

Windows 推荐从 `program` 目录运行 `tools\setup-analyzer.bat`，它会安装采集器独立锁定的 Node 依赖、配套 Chromium，并实际启动浏览器验证。仅修复采集运行环境可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-collector.ps1`。采集浏览器缓存位于当前项目的 `.local/collector-browsers`，不会复用另一个项目的运行目录；启动脚本从本项目 `.local/node.path` 还原 Node 路径。

macOS/Linux 在分析服务目录中安装采集运行环境：

```sh
npm --prefix liming_analyzer/douyin_collector/node ci --omit=dev
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/collector-browsers"
npm --prefix liming_analyzer/douyin_collector/node run install-browser
node liming_analyzer/douyin_collector/node/capture-douyin.mjs --doctor
```

Windows x64 的 Node.js 支持 22.x（至少 22.13）或 24.x（至少 24.20）；不兼容时先运行 `setup-local.bat`，在项目内准备固定的 22.23.2，不修改全局 Node。macOS/Linux 需为 22.13 或更新版本；Linux 还需准备 Chromium 系统库。后续启动分析服务时应保留同一个 `PLAYWRIGHT_BROWSERS_PATH`。单个采集视频限制为 100 MiB、1200 秒；无音轨会保留限制，不能视为已获得原音。采集失败不会尝试登录、导入 Cookie 或处理验证码。

## 配置

Worker 启动只需本项目的 `ANALYZER_BASE_URL`、`ANALYZER_SERVICE_TOKEN`、`ANALYZER_WORKER_ID`。云模型可直接在网页“设置”中保存；每个已领取任务会读取并校验所属公司的最新模型配置，无需把密钥写入环境文件才能启动服务。下列 `ANALYZER_LLM_*`、`ANALYZER_VISION_*` 保留为旧配置兼容入口：

- `ANALYZER_BASE_URL`
- `ANALYZER_SERVICE_TOKEN`
- `ANALYZER_WORKER_ID`
- `ANALYZER_LLM_API_KEY`
- `ANALYZER_LLM_BASE_URL`
- `ANALYZER_LLM_MODEL`
- `ANALYZER_LLM_PROVIDER`
- `ANALYZER_VISION_API_KEY`：当前视觉模型密钥，可在网页按公司单独保存，不回显。
- `ANALYZER_VISION_BASE_URL`：当前与 lmzy 一致为 `https://api.minimax.cn/v1`。
- `ANALYZER_VISION_MODEL`：当前默认 `MiniMax-M3.1-Flash`，通过 OpenAI 兼容图片接口调用；显式模型与地址优先于历史密钥前缀判断。
- `ANALYZER_VISION_PROVIDER`：当前为 `minimax`。原 `minimax-token-plan` / `understand_image` 的 MCP 路径仍兼容，使用原来对应的 `https://api.minimaxi.com` 配置；OCR 继续独立执行。
- `ANALYZER_VISION_CONCURRENCY`：视觉批次并发数，默认 `2`，允许 `1`～`3`；建议稳定运行后再从 `2` 调到 `3`
- `PLAYWRIGHT_BROWSERS_PATH`：macOS/Linux 可指定本项目专用 Chromium 缓存；Windows 启动脚本固定使用当前 `program/.local/collector-browsers`。
- `ANALYZER_ASR_ENGINE`：`faster-whisper` 或兼容的 `funasr`（代码缺省值保持 `funasr`）；
- `ANALYZER_ASR_MODEL`：本次部署为 faster-whisper `small`；FunASR 路径默认 `paraformer-zh`；
- `ANALYZER_ASR_LANGUAGE`：本次部署为 `zh`，faster-whisper 可选 `auto`；
- ANALYZER_ASR_FALLBACK_MODEL，默认 iic/SenseVoiceSmall；仅在末尾转写异常稀疏且能找回更多文字时延迟调用，设为空可关闭
- `ANALYZER_ASR_DEVICE`，默认 `cpu`
- `ANALYZER_PADDLE_OCR_DETECTION_MODEL`，默认 `PP-OCRv5_mobile_det`
- `ANALYZER_PADDLE_OCR_RECOGNITION_MODEL`，默认 `PP-OCRv5_mobile_rec`
- `ANALYZER_PADDLE_MODEL_SOURCE`，默认 `bos`（Paddle 官方 BOS 模型源，Windows 本地交付推荐）
- `ANALYZER_MODEL_CACHE`，建议指向 Worker 的持久化模型卷；Windows 未配置时自动使用纯英文的 `%LOCALAPPDATA%/LimingZhiyao/model-cache`

原来的 `ANALYZER_YTDLP_COOKIES_FROM_BROWSER` 和 Cookie 快照不参与当前匿名视频采集。已有上传与分析接口保持原有数据约定。

Windows 下 Paddle 原生推理层可能无法读取含中文字符的模型路径，因此模型缓存不要放在中文目录。CPU 推理默认关闭 oneDNN，以规避当前 PaddlePaddle 对 PP-OCRv5 PIR 模型的算子兼容问题。

单次领取任务：

```powershell
python -m liming_analyzer --once
```

持续运行：

```powershell
python -m liming_analyzer
```

## 本机环境与服务控制

设置页的环境面板可以准备/检查环境，并启动或停止当前项目的分析服务。依赖安装在本项目 `services/analyzer/.venv`，模型在 `.local/model-cache`，Chromium 在 `.local/collector-browsers`。不会读取其他项目的配置或使用其虚拟环境。

Windows 的网页按钮和 BAT 启停现在共用本安装的 supervisor 控制器，通过进程身份、创建时间及真实心跳区分“依赖已就绪”“进程已启动”“服务已连接”。已有服务不会重复启动；源码或绑定地址改变时会提示先等待任务结束，再停止并重新启动。停止操作只管理已验证的本安装进程。环境管理地址按安装选择可用回环端口，并核对安装和源码指纹，避免新旧目录同时运行时连接另一安装。

覆盖升级须先等待任务结束、停止旧服务，并按[备份恢复与升级操作](../../docs/operations/备份恢复与升级操作.md)保存业务状态和私密配置；完整更新程序后再启动。保留 `.wrangler/`、`.dev.vars` 和模型缓存，不用空数据或新密钥替换旧资料。网页检测到旧进程版本时会明确要求重新启动，单纯刷新页面不会更新后台 Python 进程。

采集器在 Windows 上使用 `r+b` 句柄执行落盘同步。文件同步、发布或清理失败返回 `SOURCE_PUBLISH_FAILED`；未分类内部异常返回 `SOURCE_INTERNAL_ERROR`。本地日志只保留阶段、异常类型、系统错误编号及包内代码位置，不记录异常原文、签名 URL、Cookie、私密路径或客户正文。

维护命令（均在 `program` 下执行）：

```sh
services/analyzer/.venv/bin/python scripts/analyzer_local_runtime.py status
services/analyzer/.venv/bin/python scripts/analyzer_local_runtime.py check
services/analyzer/.venv/bin/python scripts/analyzer_local_runtime.py setup
services/analyzer/.venv/bin/python scripts/analyzer_local_runtime.py start
services/analyzer/.venv/bin/python scripts/analyzer_local_runtime.py stop
```

`setup` 在环境已就绪时直接复用，不会重复安装或打断运行服务。缺少 uv 时会把安装工具准备到本项目 `.local/installer-tools`。FFmpeg/FFprobe 优先使用本机已可运行的工具；缺少时从锁定的官方 npm registry 包安装到本项目 `.local/media-tools`，Windows 设置页通过 `install-ffmpeg.ps1 -ProjectOnly` 进入同一隔离路径。工具目录记录到 `.local/ffmpeg.path`，后续启动会自动恢复，无需重启网页进程或修改系统 PATH。当前模型验收记录在 `.local/verification/media-runtime/result.json`；运行日志在 `.local/logs/analyzer-local.log`。

## 数据与安全边界

- Worker 只能使用独立服务令牌访问内部接口；
- 源媒体、字幕和关键帧均通过租约绑定的接口读写；
- Worker 不持有 D1 或 R2 管理凭据；
- 任务执行期间持续发送心跳，失去租约后不能提交产物；
- 关键帧、字幕、公开元数据和指标都由网站重新按公司、项目与视频校验。

## 验证

```powershell
python -m unittest discover -s tests -v

# 安装开发测试依赖后，覆盖迁入的采集 pytest 用例
python -m pip install -e ".[dev]"
python -m pytest tests/collector tests/test_skill_collect_source.py -q
```

自动测试使用注入的假模型，不下载大模型。正式验收仍需使用有授权的真实短视频样片和有效的模型密钥。
