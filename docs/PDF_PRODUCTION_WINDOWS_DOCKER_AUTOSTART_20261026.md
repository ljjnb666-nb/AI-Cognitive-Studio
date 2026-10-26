# Windows 实机联合验收｜自动启动 Docker Desktop

本验收工作流仅允许仓库作者的专用 PR、准确 SHA 和带 `acs-pdf-local` 标签的 Windows Runner 执行。

- 先检查资源：若空闲物理内存不足 **4 GiB**，立即拒绝启动 Docker，**不自动结束**浏览器、IDE 或任何用户进程。
- 如果 Docker Linux Engine 不可用，调用 Docker 官方 `docker desktop start --detach`；若 CLI 版本不支持，则只尝试启动预期安装路径的 `Docker Desktop.exe`。等待最多 150 秒，失败返回固定错误阶段，不修改系统配置、不下载或安装软件、不提升权限，也不切换到 Windows 容器。
- 启动 Docker 后继续严格校验 Linux Engine、C/D 盘空间、**再次检查 4 GiB 空闲内存**、固定离线镜像。只在条件全部满足时才启动随机命名的 PostgreSQL / Redis / MinIO 测试环境。
- 测试完成仅删除该次随机 Compose 项目及合成 PDF 临时目录；**不会关闭 Docker Desktop**，不会触碰用户其他容器或卷。
- 真实 Docling 同链路验证未通过前保持 `UNVERIFIED`，不以模拟模型测试或单独 Python smoke 替代，不关闭资源保护、不宣称 Gold 或生产就绪。

实测记录：旧 #195 HEAD `2d2821f7` 的 Windows 作业内存空闲 **2.46 GiB**，C/D 盘和 Docker Engine 均通过；完整 CI 6/6 PASS，但联合验收在内存门阻止启动容器。自动启动机制不能解决 RAM 不足；需要额外释放至少约 1.54 GiB，建议保持更多余量。
