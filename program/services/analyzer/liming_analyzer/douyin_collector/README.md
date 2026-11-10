# 抖音采集适配器

公开源码改编自 Skill Collect；来源文件 SHA-256 见 `SOURCE.json`，MIT 原许可见 `LICENSES/skill-collect-MIT.txt`。未迁入数据库、配置、凭据、Cookie、用户媒体或业务模型。

以下安装命令从 `program` 目录运行；macOS/Linux 先设置 `PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/collector-browsers"`，后续启动服务沿用该值。

```sh
npm --prefix services/analyzer/liming_analyzer/douyin_collector/node ci
npm --prefix services/analyzer/liming_analyzer/douyin_collector/node run install-browser
node services/analyzer/liming_analyzer/douyin_collector/node/capture-douyin.mjs --doctor
```

Python 运行依赖为 httpx 0.28.1；后端安装时复用同版本。系统需 Node、FFmpeg、FFprobe 及 Chromium 系统库。Node 独立锁文件将 Playwright 1.64.1 放入正式运行依赖。浏览器下载缓存可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定；正式采集仅继承受限环境变量，启动独立匿名上下文。

Docker 使用非 root 用户与开启的 Chromium sandbox。Compose 中的 seccomp 采用已冻结的官方 Moby 默认 profile，加上 Playwright 官方文档规定的 `clone/setns/unshare` 用户命名空间权限；来源和 SHA 见 `SOURCE.json`。Playwright 1.64.1 原始 profile 另存为 `seccomp_playwright_1.64.1.json`，该旧版在 Docker 29 中无法启动容器，不能直接替换运行 profile。doctor 使用与采集一致的 sandbox 启动参数；不通过 `--no-sandbox` 降级。

```python
from liming_analyzer.douyin_collector import collect, CollectorError

result = collect(share_text, server_owned_task_folder,
                 progress=on_real_progress, cancelled=cancel_event)
```

`CollectorAdapter.acquire()` 提供同一入口。目标项目的 `SkillCollectPublicVideoResolver` 接收并传入原有的 `ANALYZER_FFMPEG` / `ANALYZER_FFPROBE`，通过任务局部上下文配置可执行文件，不改写全局环境。取消参数可为可调用对象或 `threading.Event`。输出目录必须由服务端创建与授权，不能接受用户提交的本地路径。返回媒体路径仅用于后端内部，由服务端 StorageAdapter 接管；HTTP 层应返回受控 Asset ID。

返回字段包括 `media_path`、`video_id`、`source_url`（规范化官方页面）、`title`、`sha256`、`size_bytes`、`duration`、`has_video`、`has_audio`、`limitations`、`acquisition_method`、`identity_verified`、`coverage`、`reported_duration` 和脱敏 `evidence`。失败抛出 `CollectorError`，只对外使用 `code`、`message`、`retryable`，不要序列化任意异常属性。

本适配器限定单条官方 HTTPS 分享链接；所有 DNS 地址必须是公网地址，连接固定到验证 IP 并保留 TLS 校验。分享跳转链需始终官方且仅含一个目标 ID。静态路径补齐 Content-Range、Content-Length 和官方时长对齐；没有官方时长时进入浏览器路径。浏览器路径保留官方元数据归属、分段完整覆盖、分轨同目标/时长校验、SHA-256 和 FFprobe。最终视频限制 100 MiB、0～1200 秒；阶段预算分别控制，浏览器 180 秒不是整个任务时限。

临时资源仅在任务私有子目录产生，取消和失败清理；完成后 fsync 并原子改名。媒体没有音轨时保留限制，不表示已获得原音。访问受限、登录、验证码、删除或网络错误不会生成成功媒体；调用方可按错误分类重试或提供上传备用。

验证入口：`cd services/analyzer && python -m pytest tests/collector`。包含真实独立 Chromium 与合成 HTTP/Range/TLS 夹具，需本机回环端口权限；固定样本不等于外部采集。目标项目的新验收记录存于 `program/.local/verification/`，与源项目历史证据和用户数据隔离；具体结果见仓库根目录的《视频采集替换说明》。
