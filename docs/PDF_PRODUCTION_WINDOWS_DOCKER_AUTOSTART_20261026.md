# Windows 实机联合验收｜自动启动 Docker Desktop

本验收工作流仅允许仓库作者的专用 PR、准确 SHA 和带 `acs-pdf-local` 标签的 Windows Runner 执行。

- 先检查资源：若空闲物理内存不足 **4 GiB**，立即拒绝启动 Docker，**不自动结束**浏览器、IDE 或任何用户进程。
- 如果 Docker Linux Engine 不可用，调用 Docker 官方 `docker desktop start --detach`；若 CLI 版本不支持，则只尝试启动预期安装路径的 `Docker Desktop.exe`。等待最多 150 秒，失败返回固定错误阶段，不修改系统配置、不下载或安装软件、不提升权限，也不切换到 Windows 容器。
- 启动 Docker 后继续严格校验 Linux Engine、C/D 盘空间、**再次检查 4 GiB 空闲内存**、固定离线镜像。只在条件全部满足时才启动随机命名的 PostgreSQL / Redis / MinIO 测试环境。
- 测试完成仅删除该次随机 Compose 项目及合成 PDF 临时目录；**不会关闭 Docker Desktop**，不会触碰用户其他容器或卷。
- 真实 Docling 同链路验证未通过前保持 `UNVERIFIED`，不以模拟模型测试或单独 Python smoke 替代，不关闭资源保护、不宣称 Gold 或生产就绪。

实测记录：旧 #195 HEAD `2d2821f7` 的 Windows 作业内存空闲 **2.46 GiB**，C/D 盘和 Docker Engine 均通过；完整 CI 6/6 PASS，但联合验收在内存门阻止启动容器。自动启动机制不能解决 RAM 不足；需要额外释放至少约 1.54 GiB，建议保持更多余量。

## 2026-10-26 实测：自动启动成功但内存回落

准确 HEAD `fc2dedc4` 的同链 Windows 作业：源码 SHA+归档哈希核验 PASS；本机无需直连 GitHub；Docker Desktop 自动启动日志 `AUTOSTART=READY`；C/D 盘 PASS。启动前内存 **6.41 GiB**，启动后 **2.63 GiB**，所以再次被 4 GiB 安全门槛阻止，真实 PG/Redis/MinIO/Docling 联合链路仍未测试。工作结束时 GitHub Runner 的孤儿进程清理曾终止它启动的 Docker Desktop 后台进程，因此不能保证 Docker 在作业结束后继续常驻。

为避免下一次在已知内存不足的情况下再次启动 Docker 占用整机资源：只有当 Engine **尚未运行**，才要求启动前至少 **8 GiB** 可用物理内存（约 4 GiB 原安全余量 + 本机观测约 3.78 GiB Docker 启动开销，保守向上取整）。若 Engine **已经运行**，保留原有启动前/测试前 **4 GiB** 检查即可。门槛未降低；任何情况下都不自动结束其他程序、不重配 WSL、不删除用户容器或卷。
