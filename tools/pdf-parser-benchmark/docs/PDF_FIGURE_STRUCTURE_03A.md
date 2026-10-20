# PDF-FIGURE-STRUCTURE-03A：私人 PNG 局部区域候选及图关系提案门禁

**目标**：解决上一轮 OpenCV Hough 全页分析持续饱和（四页均截断在 120 条，主要为水平线，箭头尖端未检出）的局限。先从经过 SHA-256 校验的原始页面 PNG 提取**局部区域候选**，让后续视觉理解只观察与出处绑定的局部证据。

**范围**：独立 PDF Benchmark，不能改动正式 PDF 导入与播客生成。使用既有私人原书与 PNG，输出仅留在 D 盘。不下载模型，不向 GitHub 上传图片/OCR/书名、坐标列表。

## 脚本和事实

- `python/private_region_proposals.py`：读取先前 figure-evidence-v1 与 RB-PDF-12/13 的 SHA-256，使用已经安装的 OpenCV 对黑白像素做三档闭运算与连通区域候选。对重叠区域抑制，每张源 PNG 最多 4 个建议范围；若无合适区域，采用**墨迹外接矩形兜底**，仍需要复核。
- 采用 [x,y,w,h]，原点位于整页 PNG 左上角，输出包括原图 SHA、真实原书物理页、区域 bbox、crop PNG SHA/字节及原始 MinerU 图像引用。
- 在 `D:\ai-cognitive-pdf-benchmark-data\reports\real-mineru-39440805765-1\region-proposals-v1-RB-PDF-12/` 与对应 RB-PDF-13 目录中保存 `region-proposals.json` 和 `crops/*.png`。
- 为避免原地覆盖，使用独立 stage 目录生成后再原子改名；目标已存在就拒绝覆盖。失败不得清理用户旧输出。
- `python/vision_graph_proposal_contract.py` 为未来视觉模型或人工标注提供受约束的输入契约：节点必须有局部 bbox；每条提议边必须有局部箭头尖端及线段坐标，必须绑定单个经校验 crop SHA、来源页与现有节点。
- 关系状态固定为 `PROPOSED_UNVERIFIED / NOT_REVIEWED`；任何伪造的 `VERIFIED`、外页关系、越界或冒充另一张图片的建议都拒绝。坐标映射可以成功，但**不证明**箭头与语义正确。

## 使用方式

在经过审查的固定 SHA 独立 GitHub Runner 工作区执行，不能执行本机原 Benchmark worktree 中未经核验的 19 项修改代码：

    D:\ai-cognitive-pdf-benchmark-data\python\mineru\Scripts\python.exe -I -B tools\pdf-parser-benchmark\python\private_region_proposals.py --fixture RB-PDF-12

对 RB-PDF-13 单独运行。GH Actions 日志只能打印成功状态、处理页数、建议裁剪数；私有图片及 bbox 只保存在 D 盘。

## 验收分级

1. `PRIVATE_REGION_PROPOSALS_PERSISTED`：文件、坐标及 SHA 完整，并已生成局部图片，**不是图框识别准确率**。
2. `GRAPH_PROPOSAL_UNVERIFIED`：未来模型的建议有足够可定位证据，但还没有人工复核。
3. `GRAPH_VERIFIED`：本阶段**禁止**。需之后人工核对节点、方向、时序、来源区域后才能建立独立验证记录，不能由机器建议自行升级。

此切片**不启动云端视觉模型**，也不声称完成箭头/时序恢复。所有测试以真实 Windows Runner 工作流和独立 SHA 核验为准；源书及图像不进入公共工作流 Artifacts。
