# 利明智耀 AI 内容运营协作平台

面向企业内容团队的本地与局域网工作台，连接视频分析、对标素材、品牌知识、灵感、选题、内容生产、审核、发布与复盘。

## 目录与启动

源码及运行配置统一位于 **`program/`**。仓库根目录的三个启动入口委托给该目录中的脚本，移动项目时请保持相对位置。

```text
仓库根目录/
├─ README.md
├─ start-local.bat       本机启动
├─ start-lan.bat         局域网启动
├─ stop-local.bat        停止服务
└─ program/             源码、配置模板、迁移、测试和文档
```

Windows 首次安装运行 `program/setup-local.bat`，之后使用根目录的启动入口。网页服务需要 Node.js 22.13 或更高版本；视频分析另需 Python 3.11、FFmpeg 及媒体依赖。

命令行开发：

```bash
cd program
npm ci
# 根据 .dev.vars.example 创建并配置本地 .dev.vars
npm run db:local:migrate
npm run dev
```

详细安装、模型配置、局域网登录与交付说明见 [程序 README](program/README.md)。更新已有安装前备份本地数据；从旧平铺目录迁移时，将原配置和数据保留在新的 `program/` 中，不能用空目录覆盖。

## 当前能力

- 视频分析与共享素材库：转写、关键帧、结构化报告、项目对标引用、原视频指标与版本追溯。
- 品牌知识与内容策略：品牌事实按选题明确选择；核心内容策略固定读取，内容支柱不强制限定每次创作。
- 灵感与项目记忆：已采纳记忆辅助灵感对话，覆盖内容经验和表达方法；灵感生成或保存不会自动创建选题。
- 内容生产：普通创作可综合多条参考；单条对标仿写对齐原稿结构、字数、钩子、衔接与 CTA，提供逐段对照和定向修订。
- 独立口播改写：微调同构与内容等价重构，支持原稿对照和不可变版本。
- 团队协作与运营：公司/空间权限、审核评论、排期发布、运营数据导入与复盘、员工任务和报告。

抖音趋势预测目前只有保留的设计方案，尚未实施。电商素材已在开发分支接入独立商品、任务、装配、审核和发布回填流程，默认关闭；旧数据升级与真实商品试点尚待验收，不包含订单管理。

## 文档

- [产品使用手册](program/docs/产品使用手册.md)
- [电商素材使用说明](program/docs/电商素材使用说明.md)
- [全部文档与未来设计](program/docs/README.md)
- [视频分析与生成数据流](program/docs/architecture/视频分析数据流通说明.md)
- [项目目录及清理边界](program/docs/operations/项目目录说明.md)
- [更新记录](CHANGELOG.md)

## 验证与数据边界

在 `program/` 执行 `npm test`，包含类型检查、生产构建与 Node 测试。Python 分析器测试在 `program/services/analyzer/` 执行 `python -m unittest discover -s tests -v`，使用已安装项目依赖的 Python 3.11 环境。

GitHub 保存源码和配置模板，不保存 `.dev.vars`、Cookie、客户数据库、媒体文件、运行日志、模型缓存或交付凭证。`.wrangler/` 和 `.local/` 包含本地业务与运行状态，不能因“不提交 Git”就整目录删除。
