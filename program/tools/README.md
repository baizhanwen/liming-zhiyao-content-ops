# 维护工具

这里放低频、需要人工确认的本地维护入口。日常启动无需进入本目录。

- `setup-analyzer.bat`：首次安装或修复视频分析环境；Python 安装包和 PyPI 依赖默认优先使用阿里云镜像，失败时自动回退官方源；会通过 winget 补齐 FFmpeg，并验证 FFmpeg、Python、VC++、ASR/OCR 与 MiniMax 视觉 MCP 依赖均可执行。可传入 `--index official` 强制仅使用官方 PyPI。
- `start-analyzer.bat`：仅单独启动视频分析服务；正常情况下由项目启动脚本自动处理。
- `refresh-douyin-cookies.bat`：从导出的 Netscape `cookies.txt` 更新抖音 Cookie 快照。
- `backup-local.bat`：备份本地数据库、对象文件和运行状态。
- `restore-local.bat`：选择备份并恢复，执行前需要人工确认。

日常启动和关闭入口位于最外层文件夹：`start-local.bat`、`start-lan.bat`、`stop-local.bat`。首次安装使用 `program/setup-local.bat`，本目录的维护工具位于 `program/tools`。
