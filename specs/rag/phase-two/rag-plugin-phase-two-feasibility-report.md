# DSH RAG 插件第二阶段可行性验证报告

本文记录 `RAG2-010` 对 BGE-M3 与 USearch 的阻塞性验证结果。它只确认本地离线推理、HNSW 持久化和当前支持平台具备实施条件，不替代后续数据集质量评测和规模阈值实验。

## 1. 验证环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | macOS 25.6.0，arm64 |
| Node.js | 22.22.0 |
| Transformers.js | 4.2.0 |
| Dense 模型 | `onnx-community/bge-m3-ONNX` |
| 模型 revision | `25b9af8e87a38eb120cfe87125383677b9cd309e` |
| 模型量化文件 | `onnx/model_quantized.onnx`，568,479,395 bytes |
| USearch | 2.26.2 |

模型 revision 对应 Hugging Face 仓库的不可变提交，模型元数据声明 MIT 许可证。USearch 2.26.2 声明 Apache-2.0 许可证和 Node.js 22 以上运行要求，与仓库支持的 Node.js 版本一致。

## 2. BGE-M3 结果

固定 revision 的 q8 模型可以在首次下载后使用 `local_files_only: true` 完全离线加载。缓存占用 573,776 KiB，其中 ONNX 权重为 568,479,395 bytes，tokenizer 文件约 16.3 MiB。

本机从已填充缓存加载模型约需 1.94 秒。单条短文本的预热后推理耗时为 6.35 至 11.49 毫秒；这些数据只描述当前机器上的短输入，不是长分片、批量编码或并发吞吐承诺。

中文、英文和中英文混合输入均返回 `[1, 1024]` 的 float32 向量，L2 范数误差小于 `2e-7`。中文“光合作用把光能转化为化学能”和对应英文句子的余弦相似度为 0.7832，与无关中文句子的相似度为 0.3374。该对比只验证跨语言向量空间工作正常，不构成检索质量结论。

第二阶段固定使用 `onnx/model_quantized.onnx`、CLS pooling、L2 归一化、1024 维输出和空查询前缀。分片长度仍由后续数据集实验确定，不使用模型的最大上下文长度作为默认分片长度。

## 3. USearch 结果

USearch 2.26.2 在 macOS arm64 与 Node.js 22.22.0 上可直接安装并加载预编译原生模块。npm 包解压体积为 25,226,850 bytes，并包含以下预编译绑定：

- macOS arm64 与 x64 通用二进制；
- Linux arm64；
- Linux x64；
- Windows x64。

Windows arm64 没有预编译绑定，不列入第二阶段默认支持矩阵。Linux 与 Windows 本轮只检查 npm 发布物，仍由对应 CI 运行实际加载和持久化测试。

使用 `cos`、`f32`、`connectivity=16`、`expansion_add=128` 和 `expansion_search=64` 构建三条向量的最小索引后，保存、重新加载和只读 `view` 返回相同的 ordinal 顺序。四维夹具文件为 592 bytes；使用三条真实 BGE-M3 1024 维向量构建的索引为 12,832 bytes，保存前后均返回 `[0, 1, 2]`。

JavaScript 的 `search` 是同步原生调用且不接受 `AbortSignal`。Provider 只能在调用前后检查取消状态，不能中断正在执行的单次 HNSW 搜索；详细设计中的取消约定保持不变。

## 4. 结论与实施约束

`RAG2-010` 的本机阻塞项通过，可以继续按详细设计实现 BGE-M3、Exact 和 HNSW。实现固定 `onnx-community/bge-m3-ONNX@25b9af8e87a38eb120cfe87125383677b9cd309e` 的 q8 文件与 `usearch@2.26.2`，不得在运行时自动选择其他模型文件或 ANN 库。

跨平台结论限于发布物检查：macOS arm64 已实测，Linux arm64、Linux x64 和 Windows x64 需要在 CI 中执行同一套构建、搜索、保存、加载和只读 `view` 测试。若任一目标平台无法加载预编译绑定，应先更新详细设计和支持矩阵，不能静默回退到另一个 HNSW 实现或在用户机器上默认触发本地编译。
