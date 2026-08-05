# Python 分析服务

当前批次只实现不依赖外部模型的确定性内核：指标计算、稳健高表现阈值、样本门槛和分析任务状态契约。

```powershell
cd services/analyzer
python -m unittest discover -s tests -v
```

后续接入 FFmpeg、ASR、OCR 和模型适配时，统计计算仍保留在本服务，不交给大模型估算。
