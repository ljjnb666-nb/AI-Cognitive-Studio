# B31 扫描图箭翼像素拓扑独立复核（2026-10-23）

## 可核验事实

- 上游 Draft #132，准确 HEAD `483fca9b49ab89c696df9da73752d2ec6d782ee3`，完整 CI #39953583878 **SUCCESS**。
- B31 第 126 物理页原始 PDF 源图像，103 处 source-only V 形端点候选全部保留。上一阶段使用双翼连续性和两种背景负对照得出 `PIXEL_CONTRAST_REVIEW=3`、`BACKGROUND_INK_AMBIGUOUS=84`、`WING_CONTINUITY_WEAK=16`。
- 这些数字仅反映像素判别的复核优先级，不能说「3 条真实箭头」。GLM 先前的 5 节点/4 条有向边仅为未认证暂定预测，**本切片不读取它，也不以其数量调参**。

## 本切片具体做什么

只从完整 SHA 绑定的原始 PDF 像素和先前 source-only CV、Vtip、clutter、wing 结果计算**局部墨迹连通性**：

1. 对每处端点以固定 81×81 像素窗取原始二值图；寻找端点附近的 8 邻域前景连通分量。
2. 沿已存在的局部轴线和左右两条预期箭翼方向，各抽取五处局部墨迹邻域，检查它们是否与同一个端点墨迹分量连通。
3. 将结果标记为 `CONNECTED_PIXEL_PATTERN_REVIEW`、`DENSE_COMPONENT_AMBIGUOUS`、`BROKEN_PIXEL_CONNECTIVITY_REVIEW`。过于接近页边的位置被标记边界截断，不伪造完整连通路径。
4. **所有 103 处原索引必须保留**，同时保存源 wing 三分类和本次连通三分类的匿名交叉表，任何汇总必须与原始数量一致。
5. 连通的文字、图框等也可能与一处端点具有相同的图像拓扑，故 `CONNECTED_PIXEL_PATTERN_REVIEW` 只表示值得进一步人工或独立视觉验证的像素结构，**不证明箭头本身存在，更不能证明其方向正确**。

## 隔离、写入和审计

仅新增私有 D 盘文件：

`D:\ai-cognitive-pdf-benchmark-data\semantic_gate\b31_pixel_topology_review.private.json`

命令默认只读预检；`--write` 只允许 O_EXCL 独占创建一次；`--audit-only` 验证 provenance、输入 source 页面 SHA、完整候选索引和未认证声明。任何损坏或已有部分结果均 fail-closed，不覆盖历史来源。

owner-only 同仓库 exact-head Windows Runner 的预检、创建、再读和 **14 件既有私有证据 SHA 前后不变**必须全部 PASS。Ubuntu 固定 CPU-only NumPy/OpenCV 的合成回归包含：可连通开放箭翼、仅水平线、实心密集字形噪声、断裂箭翼、源文件篡改、伪造 gold、重复写入与全量候选未丢失。无需安装模型或发起任何网络 LLM 请求。GitHub 日志只输出匿名三状态数量，原图、电子书、截图、源 SHA、坐标、GLM 原文及 contact sheet 不上传仓库、Actions artifacts 或日志。

## 尚未满足的最终目标

- 实际节点与箭头的**独立可判读视觉参考**尚未建立。
- 该局部二值连通算法可能受到扫描粘连、低对比像素中断、边界遮挡影响，也无法单独分辨中文笔画和箭翼。
- 因此 `human_verified=false`、`arrow_direction_verified=false`、`independent_graph_gold=null`、`certified_graph_f1=null`，不能据此发布真实模型准确率，更不能宣称最终解析引擎选型完成。
- 所有 PR 保持 Draft/Open/Unmerged，未经用户明确授权不合并；保留此前首次失败与 Node20→24 Actions 警告，B15 未知计费继续隔离，B31 历史唯一一次付费 GLM 请求不可重跑。