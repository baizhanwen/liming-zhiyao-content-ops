# 利明智耀内容运营工作台

[下载最新 Windows 完整版](https://github.com/baizhanwen/liming-zhiyao-content-ops/releases/latest)

在 Release 的 Assets 中下载 `LimingZhiyao-Windows-Full.zip`。默认包含当前开发完整版功能和 4,176 条方法原子，无需激活码。首次打开时创建公司和管理员账号，之后用邮箱、密码登录；模型服务的 API Key 由使用者在设置中填写。

## 安装与使用

1. 完整解压 ZIP，打开其中的 `LimingZhiyao` 文件夹。
2. 保持联网，双击 `setup-local.bat`；缺少 Node.js 时按提示自动安装。
3. 双击 `start-local.bat`，在本机浏览器完成公司和管理员设置。
4. 在「系统设置 → 配置后直接使用」保存各用途的模型配置。
5. 需要视频分析时，在「系统设置 → 视频分析服务」点击「一键配置环境并启动」，等待依赖、浏览器与本地分析模型准备完成。

日常使用双击 `start-local.bat`，停止使用 `stop-local.bat`；团队协作使用 `start-lan.bat`。首次安装及模型下载需要网络，这个 ZIP 不包含预装依赖或模型缓存。下载包不携带开发者的密钥、数据库、媒体、Cookie、缓存或 Git 历史。

仓库已公开，可直接查看 Release 和下载附件。GitHub 自动生成的「Source code」压缩包是开发源码；安装使用请选择上面的完整版 ZIP。

## 开发与发布

源码在 `program`，本机开发及维护说明见 [项目说明](program/README.md)。原始 `lmzy` 项目不属于此交付包。

发布工作流支持推送 `full-v*` 标签或在 GitHub Actions 手动运行。工作流先进行测试和隔离安装验证，通过后发布完整版 ZIP、SHA256 校验和验证报告；验证未通过时不发布安装包。依赖安装、模型服务连通性和真实视频效果仍以使用者环境中的实际结果为准。
