# Phase 2：Docling Worker 自有 MinIO/S3 生命周期修复（2026-10-27）

基于已经通过真实 Windows 全栈的 Draft #195，解决可选 Docling Worker 在未注入共享存储时，自建 S3CompatibleStorageProvider 的 HTTP 客户端不受 runtime.close() 显式管理的问题。

- worker 构造失败立即关闭本次自建的私有存储客户端。
- 正常 shutdown 先停止 Docling Worker 的任务，再仅释放本 Worker 自建存储；幂等关闭；保留释放失败，不虚报 PASS。
- 调用者注入的共享 StorageProvider **不归此 Worker 所有**，绝不被本修复关闭。
- 纯合成单测检查作用域隔离、关闭一次、重复注册拒绝、释放异常保留。准确 HEAD 主 CI 和真实模型测试需另外验收；不得复用 #195 的旧绿色结果。
- 不改变 Docling 模型、PDF 物理页、OCR 引擎选型或 source block authority。DOCLING_LAYOUT_ENABLED 默认 false，五书独立 gold 0/5、CER 未核实，Issue #161 OPEN。未经用户授权不得合并。
