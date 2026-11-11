# Windows 版口播稿提取

Windows x64 默认用 Qwen3-ASR-1.7B INT8 在本机 CPU 上识别普通话口播，用 Whisper large-v3-turbo 定位语音时间。单独提取口播稿无需填写云模型 API Key。

1. 完整解压 `LimingZhiyao-Windows-Full.zip`，运行 `setup-local.bat` 和 `start-local.bat`，在本机浏览器完成首次设置。
2. 在「系统设置 → 视频分析服务」点击「一键配置环境并启动」。首次需要联网下载依赖和模型，Qwen 权重及分词文件约 2.40 GB，Whisper、OCR、浏览器等另计。安装程序会校验 Qwen 文件，并用一段中文语音实测识别。
3. 环境就绪后，在视频详情点击「只提取口播稿」。完成后可以在「完整口播稿」中阅读和复制全文。

同一安装目录可以复用已下载且校验通过的模型。升级前先按项目的备份恢复说明保存已有数据和配置。

已使用旧版且项目 `.dev.vars` 里有 `ANALYZER_ASR_MODEL=small` 的用户，升级会保留原选择。要切换到 Qwen，请把这项改成 `large-v3-turbo`，使用 `ANALYZER_ASR_ENGINE=faster-whisper`、`ANALYZER_ASR_LANGUAGE=zh` 和 `ANALYZER_ASR_DEVICE=auto`，再点一次「一键配置环境并启动」。新安装使用这些默认配置。
