# PDF 生产解析｜Docling 非权威候选持久化切片（阶段二）

## 本 PR 的范围

承接 #187 已验证的离线 Docling Standard 单物理页候选执行器。本 PR 新增 Prisma `DoclingLayoutSnapshot` 与增量 SQL 迁移、单页条件选择器、`inspectAndPersistDoclingLayoutSidecar()` 显式调用的持久化服务。**仍不自动插入导入任务的发布路径**，也不改变 RapidOCR、MinerU、当前提取结果或书籍分析 Outbox。

## 仅满足下列条件才能持久化

1. 导入任务属于同一租户和来源文档且已 `SUCCEEDED`，且存在 `SUCCEEDED` 正式 `DocumentExtraction`；源文件必须是真实 PDF。
2. 调用提供的 PDF 二进制 SHA-256 必须等于 SourceDocument 固定 SHA（不能通过任意 ID 写另一份来源内容）。
3. 路由计划为已保存并完成严格解析的原始物理页计划；候选页只能是非文字内容导致的 OCR_REQUIRED 页（含图像或矢量证据）。默认单次最多选 2 页、硬上限 3 页。
4. Docling 模型 SHA 必须由启动探针确认；返回的物理页、版本、模型指纹、非权威声明必须和请求一致，不能由候选结果自行提升权限。

## 幂等与失败边界

首次保存时，Markdown 字节先写入租户路径下的 SHA 寻址对象，再创建带复合租户 FK 与唯一页+模型键的 PostgreSQL 元数据。重复调用优先读取已有元数据并重新校验对象内容哈希，**不再发起模型计算**。并发只容许一个模型页快照身份；竞争结果不同则报错，而不是覆盖原快照。

安全拒绝：错误租户/源文件 SHA、错误物理页、非成功导入、模型指纹漂移、超预算候选、已保存对象篡改、数据库并发冲突。所有异常都只涉及独立候选 API：正常正文和当前发布指针从不更新。

## 验收界限

- Prisma schema/migration 必须通过 CI 的 `prisma generate`、真实 PostgreSQL 集成及完整主 CI。
- 新增集成测试在既有三页 PDF 中验证候选保存+复用、对象篡改拒绝、跨租户及错误原始 SHA、当前发布指针/正文不变；真实 Docling 模型验收依旧以 #187 专项为准。
- 不读私有电子书、不提交原始 Markdown/图片、不触发云端识别。
- 下一切片才讨论受控后台任务和复杂页条件调度；后续 MinerU 条件回退、图表语义仍未完成。

当前独立 gold 0/5，CER=null；#161 OPEN。#186/#187 和本 PR 都保持 Draft/Open/Unmerged，未获用户授权不合并。
