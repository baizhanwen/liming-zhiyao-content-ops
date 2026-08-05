# Python 分析服务

当前实现包含两部分：不依赖外部模型的确定性指标内核，以及带租约、心跳、乐观版本和幂等结果键的 Web/API 客户端。

```powershell
cd services/analyzer
python -m unittest discover -s tests -v
```

部署 Worker 时需设置：

- 平台站点根地址；
- 独立的分析服务令牌；
- 每个实例唯一且稳定的 `worker_id`。

业务处理函数接收已领取任务和心跳回调。后续接入 FFmpeg、ASR、OCR 和模型适配器时，统计计算仍保留在本服务中，不交给大模型估算。
