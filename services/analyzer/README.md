# Python 分析服务

当前实现包含三部分：不依赖外部模型的确定性指标内核、带租约与幂等结果键的 Web/API 客户端，以及可注入 FFmpeg、ASR、OCR、公开视频解析和结构化模型的分析流水线。

```powershell
cd services/analyzer
python -m unittest discover -s tests -v
```

部署 Worker 时需设置：

- 平台站点根地址；
- 独立的分析服务令牌；
- 每个实例唯一且稳定的 `worker_id`。

业务处理函数接收已领取任务和心跳回调。后续接入 FFmpeg、ASR、OCR 和模型适配器时，统计计算仍保留在本服务中，不交给大模型估算。

`AnalysisPipeline` 固定合法任务阶段，ASR 与关键帧/OCR 可以并行执行。`FfmpegMediaProcessor` 只通过参数数组调用外部进程，不使用 Shell 拼接。具体 ASR、OCR、抖音公开视频解析和结构化模型必须以适配器注入；没有配置供应商时不会伪造生产结果。
