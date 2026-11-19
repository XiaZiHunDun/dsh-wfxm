# AGENTS.md — dsh-wfxm 工作区

> **本文件是本工作区的 AI 编码工具入口。** 新会话开篇先读本文件 + `README.md`。
> **状态**：规划阶段，尚无代码。见 `README.md`。

## 1. 必读表

| # | 文档 | 何时读 |
|---|---|---|
| 1 | **[`docs/08-产品能力构想.md`](docs/08-产品能力构想.md)** | **产品侧 SSOT —— 产品该有什么（122 项：A-I 开发运维 + J 生活 + K 协议 + L 可替换 + M 保障 + N 工程化 + O 核心机制）** |
| 2 | **[`docs/07-dsh能力盘点与覆盖评估.md`](docs/07-dsh能力盘点与覆盖评估.md)** | **实现侧 SSOT —— dsh 提供什么、缺什么** |
| 3 | [`docs/05-落地路线.md`](docs/05-落地路线.md) | 动手前 |
| 4 | [`docs/03-渠道选型.md`](docs/03-渠道选型.md) | 碰渠道前（渠道实例 + 渠道 × 客户端矩阵） |
| 5 | [`docs/06-风险与待验证.md`](docs/06-风险与待验证.md) | 做决策前 |
| 6 | [`docs/01-决策背景与现状.md`](docs/01-决策背景与现状.md) | 了解背景 |
| 7 | [`docs/02-dsh-能力对照.md`](docs/02-dsh-能力对照.md) | 评估技术工作量时 |
| 8 | [`docs/04-WFXM-资产盘点.md`](docs/04-WFXM-资产盘点.md) | 规划迁移优先级时 |
| 9 | **[`docs/09-能力对照与实现路径.md`](docs/09-能力对照与实现路径.md)** | **桥 —— 08 的 122 项 → 用/适配/自建/换方案 + 工程量分级 + 对 01-08 的复核修正** |
| 10 | **[`docs/10-产品定位与功能设计决策.md`](docs/10-产品定位与功能设计决策.md)** | **定位与功能设计 —— 动手前先读；建议稿，待 owner 确认** |
| 11 | **[`docs/11-架构锚定.md`](docs/11-架构锚定.md)** | **架构 SSOT（定稿 v2.1）—— 内核 7 模块 / 端口 / 适配器、三个客户端、六个生命周期、端到端场景、数据所有权、AR1–AR37 不变量（AR25 唯一 orchestrator 前台，AR8 并发写隔离，AR35–AR37 线程/订阅）；**§10.1 已知张力：不是「控制面+数据面」，是决策面/执行面/账本**；选型前必读** |
| 12 | **[`docs/12-技术栈选型.md`](docs/12-技术栈选型.md)** | **技术栈（定稿 v1）—— 骨架 15 项已定 / 插件 8 项待验收 / 0 项待 owner；环境基线 §10.3；实例级选型 §10.4；版本矩阵 §10.5** |
| 13 | **[`docs/13-核心能力方案.md`](docs/13-核心能力方案.md)** | **两个核心痛点的机制（方案稿）—— 对话与记忆不乱（装配预算/隔离/事实卡/事实体检）、任务成功率（Verifier/快照/重试分级/Outbox）、专家执行器与领域路由；RAG / 图库 / A2A 的取舍** |
| 14 | **[`docs/14-飞书接入方案.md`](docs/14-飞书接入方案.md)** | **主通道怎么接（方案稿）—— 长连接免公网、open_id 配对、卡片按钮审批闭环、插件剖面、冒烟验收清单；冒烟前必读** |
| 15 | **[`docs/15-数据与契约.md`](docs/15-数据与契约.md)** | **建库与写代码前必读（设计稿）—— 表的归属与唯一写者、端口签名与 10 类错误、契约测试骨架、迁移规则** |
| 16 | **[`docs/16-部署与运行.md`](docs/16-部署与运行.md)** | **上服务器前必读（设计稿）—— 目录布局、systemd 非 root + polkit 细粒度授权、八步启动自检、蓝绿回滚、备份与还原演练** |
| 17 | **[`docs/17-Agent侧设计.md`](docs/17-Agent侧设计.md)** | **写提示/工具/skill/子代理前必读（设计稿）—— 5 个 preset（含 `orchestrator` 前台）、提示六块与预算、工具清单与粒度六条、skill 划分、子代理上限与 AR30、30 条 S1 规则、Verifier 三级来源与安全执行** |
| 18 | **[`docs/18-Super-agent对照与改进建议.md`](docs/18-Super-agent对照与改进建议.md)** | **动主动路径/线程订阅/守望/并发写策略前必读（建议稿）—— DeepSeek Super-agent 对照、A 类可吸收 13 条、B 类 4 条（B1/B4 已生效、B2/B3 待拍板）、C 类不吸收、决策清单 D18-1..7；C 方案已回写 v2，B1/B4 生效 v2.1** |
| 19 | **[`docs/19-记忆核验与出口脱敏建议.md`](docs/19-记忆核验与出口脱敏建议.md)** | **改事实卡/记忆写入/脱敏前必读（建议稿）—— 写入前只读探针核验（`kind`/`evidence`/三态）、事实体检第 5 类「失效」、不变量可执行化、`redact` 出口脱敏、双盲差分报表；D19-1..4 已全部落定（A/B/B/B，13/15/16/12 已回写）；A 类 6 条、C 类 6 条不吸收** |

> **产品侧（08）与实现侧（07）各是 SSOT，不要互相反推。**
> 用 07 反推产品设计 = 把"实现有什么"当"产品该有什么"，是本项目早期走过的弯路。

## 2. 相关仓库（只读参考）

| 路径 | 角色 |
|---|---|
| `/home/ailearn/githubpro/deepseek-harness` | dsh 源码 `v0.2.1-alpha.3` — **只读**，除非决定开发 dsh 本体（当前不） |
| `/home/ailearn/githubpro/cordis` | Cordis 内核源码 — 注意它与 dsh `vendor/` 里那份**不是同一版本**（见 06） |
| `/home/ailearn/projects/WFXM` | Butler 迁移源 — **只读**，除非执行 04-E 的抽包工作 |

## 3. 硬约束

1. **不 fork dsh / dsh-im。** 扩展方式一律是挂插件。理由见 `05-落地路线.md`。
2. **不重写 iLink 协议层。** WFXM 已有 **1,228 行非测试**实现（含测试共 1,920 行 / 17 文件；口径见 09-三）。
3. **插件版本要锁定。** peer 不匹配时宿主会**静默跳过整个 bundle**，表现为"插件消失"。
   本地 `link:` 挂载**不会**替你解析 peer——插件必须在自己 workspace 里装好 peer 依赖；
   每次挂载后至少做一次 `dsh --profile <name> --dump-config`（看条目）+ 真实启动（看无挂载错误），
   再跑一遍"注册了几个工具 / 未审批是否被拒"的冒烟（2026-11-06 `svcops` 已按此验证）。
4. **`@deepseek-ai/dsh` 是依赖不是源码。** 运行版本锁 **`0.2.1-rc.2`**（dsh-im 5.7.0 / dsh-email 0.20.3 的验证基线）；本地源码快照 `alpha.3` 只作参照。环境用 **Node 24 LTS + pnpm 11.28.5**，先做隔离（05-Step 0）。
5. **不要把 Butler 的死链与文档漂移带过来。**
6. **产品能力先定，实现后对。** 新增/修改能力时：先改 `08`（产品侧），
   再评估实现代价，**不要**因为"dsh/现有代码没有"就不设计这一项。

## 4. 现状提醒

- **产品能力构想（08，122 项）与能力对照（09）均已完成** —— 09 含逐条判定、工程量分级，以及对 01-08 的复核修正。
- **核心机制方案（13）已写** —— 两个决定性痛点是「对话与记忆不乱」和「任务成功率」；
  主解不在更花哨的检索，而在**装配预算 + 作用域隔离 + 事实版本化**、**Verifier + 前置快照 + 重试分级 + Outbox**；
  RAG 降为增强项，**图数据库不引入、GraphRAG 只用于知识层、A2A 只作专家接入协议**。
  **2026-11-05 增补**：压缩直接用 dsh `compaction-basic`（阈值/配对切点已有），只补超长单轮、在飞工作摘要、事实卡冷边界注入；
  R3 前置快照须有 git HEAD 基线（15 `snapshots.baseline_ref`）；专家消息有寻址限制与配额。
- **领域能力外包、治理自留**（AR34）：专家 agent 以受限执行器接入，无自有审批/凭据、不得出 A 域、事件必须回传。
- **飞书接入方案（14）已写**：长连接（免公网）+ `open_id` 配对 + 卡片按钮审批（`approval_id` + `nonce` 防重放）；
  **卡片只是视图，审批正本在 `approvals` 表**；插件只许启用 transport 四类动作，超出即拒绝启动。
- **产品定位与设计决策建议稿（10）已写，待 owner 确认。** 确认后回写 08；确认前 08 仍是产品侧 SSOT。
- **Super-agent 对照建议稿（18）已写。** 结论：骨架同源，真正缺的是**线程/订阅**、**策略版本与准入强度**、
  **长任务守望**；A 类 13 条可低成本吸收，B 类 4 条（Thread/主动路径/Watchdog/per-task worktree）见 D18-1..7。
  **B4 已由 owner 定为 B4-b 并生效**（2026-11-03）：git + A 域一任务一 worktree，非 git / B 域 workspace 串行，V2 先补洞；
  结构与 AR8 改写已回写 [11 §十四](docs/11-架构锚定.md)、数据契约已回写 [15 §十](docs/15-数据与契约.md)，
  **v2.1 已生效，AR8 正文与 15 §三表结构以回写版为准**。B2/B3 仍待拍板。
  **前台架构已由 owner 定为 C 方案**（2026-11-03）：Router 作为唯一前台，窄工具面，执行/审批/配置留后台；
  **已回写 v2**：[11](docs/11-架构锚定.md)（AR25 v2 / §5.3 旁路 / §5.8 G2）、[15](docs/15-数据与契约.md)（`outbox` 归 ① / `route_decisions` / `session_kind`）、
  [17](docs/17-Agent侧设计.md)（`orchestrator` preset）、[13](docs/13-核心能力方案.md)（Thread 作用域装配）、[14](docs/14-飞书接入方案.md)（同 Thread 回复）、[08](docs/08-产品能力构想.md)（连续前台四条）。
  B1 已回写并**生效 v2.1**（[11 §十三](docs/11-架构锚定.md) 结构 + [15 §九](docs/15-数据与契约.md) 数据契约）；
  **B1/B4 已生效，线程/订阅与并发写的既有结论按回写版执行（C 方案前台回写同时有效）。**
- **数据与契约（15）、部署与运行（16）已写**：单库 `ops.sqlite` + `schema_migrations(module, version)` + 10 类 `PortError`；
  部署为 **systemd 非 root（`dshwfxm`）+ polkit 细粒度授权（只放 `dsh-wfxm-managed-*` unit）+ 蓝绿 `releases/` 软链**，
  启动八步自检任一步失败即拒绝启动；**审计链断 → 告警并停写业务，不自动修复**。
- **Agent 侧设计（17）已写**：5 个 preset（`orchestrator` / `chat` / `task` / `subagent-ro` / `expert`，其中 `chat` 仅 Web 深度会话）、提示六块与预算、
  工具清单（三件套 schema/风险基线/端口，缺一拒绝注册）、30 条 S1 规则、7 种断言 DSL 与三级来源；
  **无判据的 R2+ 任务直接拒绝提交**。
- **Step 1 已降级为冒烟测试**，并入 Step 2 第一步；**架构已定稿 v2.1（11，AR1–AR37，AR25 唯一 orchestrator 前台、AR8 并发写隔离）**；**技术栈已定稿 v1（12）**
  ——骨架 15 项已定、插件 8 项只定验收门槛、**0 项待 owner 输入**（环境基线：普通 Linux + 可出网、无入站需求），可进入实施准备。
- **V1（多项目并行不打架）、V3（对话不再劣化）是成立条件**，其余是能力项。**V2 不构成分叉点**（见 09-四）。
- 🔴 **V2 结论已更正（09-六·修正 1）**：dsh **有** `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`
  跨进程锁原语，只是没接到 agent 编辑路径上。要自己定的是**策略语义**（锁粒度、冲突退让），不是从零造锁。
- **多 agent 能力就是隔离机制**，不是另有一套（见 07-L3 机制澄清）。
- ⚠️ **子代理共享治理**：dsh 的 subagent 与父 agent 共享 admission/ownership，
  与 WFXM「子代理不继承父代理全部权限」规则方向相反。用并行子任务前必须单独验权限边界。
- **不需要 ADR**：本仓是独立新仓，不修改 WFXM；WFXM 保持全绿作为回退路径。
- **主通道已定：飞书**（v1 唯一启用；长连接免公网 + 卡片由网关渲染）；微信 ClawBot 入口 ✅ 已有 → **P1 兜底通知**；审批交互 = 飞书卡片按钮
- 外部风险主要是**腾讯账号风控**（**仅在启用微信兜底时成立**，主通道飞书不受影响，见 06）；**最大的内部风险是「版本撕裂」**——
  dsh 明文承诺破坏兼容，自有治理插件也要跟着走 → **须先定版本锁定 + 插件兼容测试矩阵**（见 09-四）
- **「服务/进程管理」两边都缺**，是 P5 管家目标的最大空白——**owner 已定管家进 V1，故 `svcops` 立即立项**（Step 4）
- **社区插件探测（2026-10-29 实测）**：GitHub topic `deepseek-harness-plugins` **293** / `deepseek-harness-plugin` **922**。
  渠道第二选项 `dsh-im-gateway` 降为**仅当 `dsh-im` 飞书适配不达标时**才评估；`dsh-ops` **不是**运维工具（是 token 效率插件）；
  systemd / backup 类**无可用供给** → `svcops` 自建结论更硬。详见 11 §三·社区插件候选、12 §三·L2.5 复核
- **插件边界靠剖面而非信任**：第三方插件按**接入剖面**启用（只允许 transport 四类，禁用其建会话/做审批/建任务/写配置），
  启动自检比对、超出即拒绝启动；配合 **AR30**（子代理权限不得放大）、**AR31**（工具可换、闸不可绕）、
  **AR32**（端口契约实现无关，`ports/` 内零协议名/命令/产品名）、**AR33**（跨模块只经 API 或事件，禁直读表）
- **记忆核验与出口脱敏建议稿（19）已写；D19-1..4 已全部落定（A/B/B/B，2026-11-06..09）。** 核心结论：我们的事实体检全是**事后**的，
  缺"**写入前只读探针核验**"（`kind=environment|preference` + `evidence` + 吻合/矛盾/探不到三态）；
  事实体检缺第 5 类「失效」；`redact` 出口脱敏原先**设计有、实现与测试缺**——现已实现（见下）。
  **已回写**：08 O2（四类→五类）、13 §2.3（`kind`/`evidence` + 三态纪律）、13 §2.5（失效 + 复核候选）、15 `memory_facts` 三列；**A1/A2/A3 与复核候选已随 ⑥ 第一片落地（见下）**。
  A5 已有代码：`plugins/redact`（`@dsh-wfxm/redact`，九类模式、幂等、21 例）。
  **四处接线已齐**：① 出站 outbox（`enqueueOutbox` 落库前 redact）+ ⑥ 记忆写入前（`checkFacts` 在 fact 入库前 redact）+ ④ 审计 payloadDigest（`toAuditFields` 与 `grants-admin.record` 均先 redact 原文再算 sha256，密钥永远不进 audit_log 表）+ 日志（plugin 源码内所有 logger 调用均为元数据，不含原文；若后续有打印内容原文的点需补 redact）。
  A4 已有脚本：`scripts/check-invariants.mjs`（AR32/AR33 静态扫描，`pnpm check:invariants`，11 例夹具）。
  A6 已有骨架：`bench/`（20 项固定任务 + `run.mjs` 执行缝 + `report.mjs` 差分/归档，`pnpm verify:bench`，13 例）；**真实 A/B 跑待执行器与凭据，未跑**。
  C 类 6 条不吸收（RMM 重排 / 全库图谱 / 并行舰队 / 强制行内 Citation 等）。
- **工作区快照已按三层粒度定稿（13 §3.4，2026-11-09）**：**文件级前镜像**（`file_preimages`，每次 `write`/`edit` 前；
  ≤1 MiB 内联、超限外置、不存在记 `absent` 墓碑、同目录临时文件 + 原子 `replace` 恢复）+ **工作区级**（`snapshots`：
  `locator` 自包含而非只存 `manifest`、基线校验、每工作区保留 100 个、`content_key` 去重 + `ref_count`、`capture` 10s 超时即拒）
  + **沙箱级（含内存）不引入**（单机 systemd、无常驻池，写明是决定）。步级回滚按 `checkpoint_id` 逆序、只动本任务写入集合（R2），
  整任务回滚 R3；将来若引入 COW/隔离写层，**建立失败必须拒绝执行，禁止静默退化为直接写**（已补 AR14）。
  **文档落点**：08 M1（能力）、13 §3.4（机制）、15（`snapshots` 两列 + `file_preimages` 表）、09 M1（实现路径）；
  **第一片已落地（2026-11-09）**：`plugins/snapshot`（`@dsh-wfxm/snapshot`，`schema_migrations(module='snapshot', v1)`，**17 例**）——
  前镜像（`(tool_call_id, path)` 幂等、`absent` 墓碑、1 MiB 内联 / `file:` 外置、原子 rename 恢复、按任务逆序回滚）、
  工作区级（两次扫描比对 manifest → `concurrent-mutation`；`.tmp` + rename；`dir:` 还原；`prune` 保留最近 100；`contentKey` 去重 + `ref_count`）、
  `createSnapshotPort`（⑤ 的结构契约，`resolveRoot` 由宿主注入；R3 任务经真实端口跑通 ⑤ ↔ ⑦）。
  **④ 已把前镜像钩进编辑路径（2026-11-09，`plugins/governance/src/preimage/hook.ts`，13 例）**：`tools/pre-execute` 策略放行后、
  `next()` 前对 `write`/`edit`/`str_replace_editor` 取前镜像，取不到即 `deny`（reason `preimage-failed`，fail-closed）；
  policy 新增 `preimages`（`enabled`/`roots`/`inlineLimit`/`contentDir`），根外与相对路径只 `skipped` 不猜。
  **⑤ → ④ 任务归因已接（2026-11-09）**：⑤ worker 用 `AsyncLocalStorage`（`plugins/tasks/src/context.ts`：`runWithTaskContext` /
  `currentTaskContext`）包住执行器调用，宿主接一行 `setTaskContextResolver(currentTaskContext)`（`@dsh-wfxm/governance` 导出）
  → `file_preimages.task_id`（及第五片的 `checkpoint_id`）落值、`rollbackPreimages` 端到端可用；**解析器缺失/抛错只丢归因、不丢前镜像**。
  **边界**：`restic:` 只做契约校验未实现；`file_preimages.checkpoint_id` 已由 ⑤ 第五片（`task_checkpoints` + `runWithCheckpoint`）落值，
  步级回滚触发入口已由 ⑤ 第六片（`task_rollback` R1 + ① `/rollback`）补齐；无巡检/备份编排。
- **模块 ⑥ 记忆与项目已落地第一片（2026-11-09）**：`plugins/knowledge`（`@dsh-wfxm/knowledge`）——
  `projects` / `memory_facts` / `memory_edges` / `project_aliases` 四表（同一 `ops.sqlite`，`schema_migrations(module='memory', v2)`，只取代不删除）；
  **A1 写时校验**（`environment` 缺 `evidence` 拒写、`project` 缺 `projectId` 拒写、`inferred` 缺 `confidence` 拒写）；
  **A3 三态闸**（吻合写入 / 矛盾拒绝且不删旧值 / 探不到写为 `unverified`，探针只读 fail-soft）+ `redact` 第四处挂载；
  **A2 五类体检 + 复核候选**（`mem_health` R0，只提示不降权）；工具 `mem_facts`(R0) / `mem_remember`(R1) / `mem_health`(R0)，45 例通过。
  **项目别名（11 §5.3.1 片 1）**：`addProjectAlias` / `removeProjectAlias` / `listProjectAliases` / `resolveProjectAlias` /
  `listProjectChoices` —— 小写归一、同项目幂等、跨项目与"遮蔽真名"均 `conflict`、归档不删但不再匹配；解析先别名后真名。
  **跨项目边界已定（08 §七 #3）：项目事实隔离、偏好共享** —— `kind=preference` 恒为全局（带 `projectId` 拒写）；
  项目上下文读 = 全局事实 ∪ 本项目事实（`liveFacts({ forProject })`），无上下文只读全局、`scope=project` 无 `projectId` 拒绝。
  **片 3 装配点（`plugins/knowledge/src/context.ts`，2026-11-10 已落地 + 端到端）**：
  `createProjectLookupPort(store)` 即 ① 的 `ProjectLookupPort` 真实实现（结构契约，① 不导入 ⑥；`pnpm -r invariant` 过 AR32/AR33）；
  `projectMemoryContext(store, { projectId })` 返回 `{ project, facts, fingerprint, injectedAt }`，未知/归档项目 `not-found` **拒绝装配、不回退全局**，
  `touch` 写 `last_injected_at`（19 D19-4）。端到端宿主装配示范：同库开 gateway + knowledge store（schema_migrations PK(module) 不同 module 值共存）→
  raw SQL 往 `projects` / `project_aliases` 插 fixture（让 `resolveAlias` 先 alias 再 name、`listProjects` 过滤已归档）→ `createProjectLookupPort(memoryStore)` 喂
  `ingestInbound({ store: anchorStore, project: realPort }, ...)`，93 例（`verify-gateway`）含：真实 alias 匹配 + 写 session_route、锚点继承 `followUp.project_id` 后 `nameOf` 查真实 ⑥ 名字、
  archive 一个后自然语言走 `matchedBy='single'`、archive 项目 `resolveAlias` 直接 null 不匹配、`projectMemoryContext` 拒绝归档项目 + 返回 global + 本项目 facts + fingerprint。
  **边界**：探针仅 `path`（只读、绝对路径、仅存在性）；`unit`/`port`/版本谓词在 ⑦ 接线前一律 `unverified`；
  提示侧的分块/截断/权重（13 §2.3）待宿主装配层。
- **模块 ⑤ 任务运行时已落地第一片（2026-11-09）**：`plugins/tasks`（`@dsh-wfxm/tasks`）——
  `tasks` / `task_events` / `task_assertions` / `receipts` 四表（`schema_migrations(module='tasks', v1)`；`task_events` 触发器只追加）；
  8 状态白名单状态机 + 终态无出边；七类断言 DSL（静态校验：≤8 条、禁 shell 片段/通配、路径限根、URL 禁凭据）与只读 Verifier；
  `complete` 只在全部断言 `pass`（或 R0/R1 无断言）时允许 `succeeded`，`skipped` 拒绝完成；工具 `task_submit`(R1) / `task_status`(R0) / `task_control`(R1)，42 例通过。
  **边界**：无执行器/worker（`start` 由调用方驱动）；`service_active` / `page_contains` 需 SvcOps / Browser 适配器注入（缺则 `skipped`）；
  `outbox` 归 ①（⑤ 只写回执，`delivered_at` 恒 NULL）；B4 `isolation_*`、重试分级（13 §3.3）、前置快照（13 §3.4）待后续切片。
- **模块 ⑤ 任务运行时已落地第二片（2026-11-09，B1 订阅闭环）**：`schema_migrations(module='tasks', v2)`（版本列表，v1 库原地升级）——
  新增 `task_threads` / `task_inputs` 与只读视图 `v_task_anchors`（五列固定，① 已按此消费）；`tasks` 补 `origin_msg_id` / `task_ref`
  （10 位随机、撞码重生 4 次）+ `ux_tasks_task_ref`。模块 API：`bindThread` / `releaseThread` / `occupancy` / `listTaskThreads`、
  `enqueueInput` / `pendingInputs` / `markInputDelivered` / `markInputRead` —— 同键 `bind`、重复 `enqueue`、重复 `release` 幂等；
  第二个 live `default_owner` 抛 `conflict` 且**不抢占**；`enqueue` 轮次只取 `tasks.round`；`release_reason` 只允许四值；**59 例通过**，
  含与 ① 的跨模块验收（共享库上 `hasTaskAnchorView()===true` 且 `resolveFollowUp` 命中真实锚点）。
  **边界**：① 的投递接线已由 ① 第三片（`TaskRelayPort`）完成；`receipts.external_msg_id` 仍由 ① 送达后回填。
- **模块 ① 渠道网关已落地第一片（2026-11-09）**：`plugins/gateway`（`@dsh-wfxm/gateway`）——
  `inbox` / `actors` / `channel_bindings` / `session_routes` / `route_decisions` / `outbox` 六表（`schema_migrations(module='gateway', v1)`；
  `route_decisions` 由触发器拒绝改写）；`(channel_id, msg_id)` 落库即去重（AR28）、open_id 配对/解绑（一 open_id 一活绑定）、
  多聊天共享同一 `orchestrator` 会话（`session_routes`）；**单投递器**（租约抢占、租约过期回收、`external_msg_id` 非空才算 ack、
  退避 1s/5s/30s/2m/10m、6 次 `failed`、手动重投）与注入式 `OutboxTransport`；
  工具 `say`(R0) / `thread_lookup`(R0) / `disposition_record`(R0)，42 例通过。
- **模块 ① 渠道网关已落地第二片（2026-11-09）**：`schema_migrations(module='gateway', v2)` 新增 `threads`（B1 锚点；
  迁移改为版本列表，v1 库原地升级不重建旧表）；`ingestInbound` 落地**分诊 + 旁路**（AR25 v2）——
  未配对身份落库后 `rejected`+`ignore` 审计、审批卡片应答 / `stop|pause|resume|status` 结构化命令 / bot-CI 消息不进前台，
  默认分诊可被注入的 classifier 覆盖（抛错 fail-closed，消息留 `accepted`）；锚点解析只经 ⑤ 的只读视图 `v_task_anchors`
  （缺失 fail-soft），按 11 §13.3 命中 live → `attach`、单 live → `attach`、多 live → `ask` 反问、
  已结束 → `attach` 且标 `requiresGrantCheck`（AR37）；`thread_lookup` 拆分 `threadId`（锚点/决策）与 `chatId`（会话粘性），
  输出新增 `thread` / `followUp`；**58 例通过**。
  **边界**：transport 仍是注入式假实现（真实飞书长连接/卡片回调未接）；`task_threads` / `task_inputs` 与 `v_task_anchors`
  归 ⑤（① 不建表、只读视图）；审批卡片渲染待后续切片；`session_routes` 的 `chat_id` 改名与出口脱敏已由第六片补齐。
- **模块 ① 渠道网关已落地第三片（2026-11-09，锚点投递接线）**：新增注入式 **`TaskRelayPort`**（`attach` → ⑤
  `bindThread(relation='anchor')`、`enqueue` → ⑤ `enqueueInput`），宿主用 ⑤ 的模块 API 组合，① 不导入 ⑤ 包、不读写其表（AR33）；
  `ingestInbound` 锚点命中后：命中 reply 锚点先 bind 再 enqueue，**只有 live 任务入队**（已结束只 attach，唤醒等 ③ 复验 AR37；
  系统/CI 消息只记上下文）；无端口时行为不变（`relay.skipped='no-port'`）；投递失败 → `inbox=failed` + `relay-unavailable` +
  保留 attach 决策（不静默丢消息）。**62 例通过**（4 例 relay）；⑤ 侧另有端到端验收（ingest → `task_inputs` pending + anchor 订阅、重放不二次入队）。
  **边界**：真实飞书 transport / 卡片渲染仍假实现；`session_routes.chat_id` 改名与 `redact` 出口接线已由第六片补齐。
- **回执闭环已落地（2026-11-09，① 第四片 / ⑤ 第三片）**：`schema_migrations(module='gateway', v3)` 给 `outbox` 加
  **`dedupe_key`** + `ux_outbox_dedupe`（`enqueueOutbox` 同键返回既有行）；新增 **`ReceiptRelay`**（`plugins/gateway/src/receipt-relay.ts`）——
  经注入的 **`TaskReceiptPort`**（⑤ `pendingReceipts` / `markReceiptDelivered`）把未送达回执转成 `task.receipt` 出站行
  （`dedupeKey=task-receipt:<receiptId>`，带 `task_id`/`thread_id`；**无 live 线程则跳过并保持 pending**，不假装送达）；
  投递器新增 **`onSent(item, externalMsgId)`** 钩子，送达后回填 `receipts.delivered_at` / `external_msg_id`；
  钩子抛错只计 `settleFailed`，**不回退已送达行**。⑤ 的 `pendingReceipts` 返回公告线程（`default_owner` 优先、次选最新 live anchor）。
  **67 例（①）/ 64 例（⑤）**，含 ⑤→①→渠道→⑤ 端到端（写回执 → pump → 投递 → 回执回填）。
  **边界**：纯 Web 任务的回执保持 pending 待后续渠道；outbox 6 次失败后可通过 **`outbox_retry`** 工具（① tools.ts L296-L375，R1，单 id 或批量 all+limit）重投，`failed` 行 → `queued` 重置 attempts，回执仍 pending。
- **模块 ① 渠道网关已落地第五片（2026-11-09，控制命令接线）**：新增 `plugins/gateway/src/task-control.ts` 与注入式
  **`TaskControlPort`**（`control({taskId, action})` → `{status}`），宿主用 ⑤ 的 `store.transition` 组合（① 不导入 ⑤ 包，AR33）；
  `stop→cancel`、`pause→pause`、`resume→resume`，`status` 只读（`skipped='status-only'`）。
  `ingestInbound` 控制分支先 `resolveFollowUp` 取锚点任务再调端口；`LIVE_STATUSES` 补 `'paused'`（可寻址，输入只排队不唤醒）；
  端口抛错 → `inbox=failed` + `control-unavailable`，决策保留 `targetTaskId`；`RouteTarget.control` 带 `taskId`，
  `IngestResult.control` 回传 `{executed, action, status, skipped}`。**74 例（①）/ 66 例（⑤）**，含 ①→⑤ 控制端到端
  （`stop` 后任务 `cancelled` 并写回执、`pause`/`resume` 往返、`status` 无副作用）。
  **边界**：控制命令以裸文本发送（`2026.11.16-5` 起）：英文 `stop/pause/resume/rollback/status`
  可单独使用；中文 `停止/暂停/继续/恢复/回滚/状态` **必须带任务 ref**（防止「继续」这类日常用语被误判）。
  签名卡片按钮归 v1.1。
  **`stop` 是真终止（`2026.11.16-4`）**：`control()` 先 `cancelRunning(taskId)` 打断 executor 的 `AbortSignal`
  （SIGTERM→SIGKILL）再落 `cancelled`；worker 见到 `cancelled` 行就只释放资源锁并返回 `skipped:'cancelled'`，
  不再 settle/迁移/补回执。`leaseOwner` 已清空但状态为 `cancelled` 时不算 `stale-lease`。
  **`resume` 是重新入队（`2026.11.16-7`）**：`继续 <ref>` 走 `resumeTask()`，`paused → queued` 并清租约、
  `attempt = 0`、清 `started_at`，worker 下一 tick 从头执行（不是断点续跑）。
  **静默自动暂停**：`running` 超过 `DSH_WFXM_TASK_STALL_MINUTES`（默认 15）无事件 → 先杀子进程再 `paused`，
  受 `DSH_WFXM_WATCHDOG_PAUSE`（默认开，`0` 关）控制。
  **主动候选（observe）**：巡检 fail/warn 写入 `inspection_candidates`（唯一键 rule/item/target，恢复转 resolved），
  即时告警附「observe，不自动建任务」，日报汇总候选计数；**没有 auto 分支**，候选不会创建任务。
- **模块 ① 渠道网关已落地第六片（2026-11-09，session_routes 改名 + 出口脱敏）**：`gateway` **v4/v5/v6** 按 15 §9.3
  三步落地（expand `chat_id` / backfill / contract 重建表，**不合并**；v6 前 `guard` 校验 `chat_id` 非空且无重复 PK，
  半迁移库**拒绝启动**不回退）；PK 改为 `(channel_id, chat_id, session_kind)`，`thread_id` 已删；
  模块 API 与 `thread_lookup` 同步改名 `chatId`（`setSessionRoute({chatId})` / `getSessionRoute(channelId, chatId, kind)`）。
  **出口脱敏**：① 是 `outbox` 唯一写者，`enqueueOutbox` 落库前对 payload 做 `redactDeep`（`@dsh-wfxm/redact` 成为运行期依赖）——
  `say` / `task.receipt` / 任何入队行都在**落库前**脱敏，密钥不进库也不进 transport。**76 例（①）**，
  含 v1→v6 升级（旧 `chatId` 回填）、半迁移拒绝、出站前后无原文密钥。
  **边界**：真实飞书 transport / 卡片渲染仍未接；19 D19-2 的四处挂载已有两处（① 出站 = 本片、⑥ 记忆写入），日志与 ④ 审计待接。
- **模块 ⑤ 任务运行时已落地第四片（2026-11-09，worker / 租约 / 重试分级 / 快照闸）**：`schema_migrations(module='tasks', v3)` 加
  `next_attempt_at` + `ix_tasks_wake`；`running → queued` 为**唯一重试边**（`task.retried`），终态仍无出边。
  store 新增 `claimTask`（事务内领最老可唤醒 `queued`、试次 +1、写租约）/ `renewLease`（仅持有者）/ `requeueTask` /
  `recoverExpiredLeases`（过期有余次回 `queued`，用尽 `failed` + 回执，不静默卡死）；
  `plugins/tasks/src/worker.ts` 的 `createTaskWorker({execute, snapshot?, ...})` = 领任务 + 心跳 + 结算，执行前后校验租约归属。
  **重试分级**：仅 `transient` 退避重试（1s/5s/30s），`permission_denied`/`not_found`/`invalid_input`/`conflict`/`unknown` 一律终态。
  **R3 快照闸**：必须先经注入的 `SnapshotPort.capture`，端口缺失或失败即 `failed`（`snapshot-refused`），绝不先做再说。
  **75 例（⑤）**。**边界**：worker 只领 `queued`；`waiting_input`/`waiting_approval`/`paused` 的恢复仍由前台命令驱动；
  快照实体归 ⑦（⑤ 只存 `snapshotId` 事件引用）。
- **模块 ⑤ 任务运行时已落地第五片（2026-11-09，步级 checkpoint）**：`schema_migrations(module='tasks', v5)` 新增
  **`task_checkpoints`**（`seq` 任务内 1 起递增、`status` 只允许 `open|committed|aborted`、`ux_task_checkpoints_seq`）；
  store 新增 `beginCheckpoint` / `closeCheckpoint(id, 'committed'|'aborted')`（二次关闭 `conflict`，写 `task.checkpoint` 事件带 `phase`）/
  `getCheckpoint` / `listCheckpoints`；**不新增状态机边**（checkpoint 不是任务状态，一个 `running` 任务可开合多步）。
  `TaskContext` 加 `checkpointId`：worker 以 `null` 起，执行器用 **`runWithCheckpoint(id, fn)`** 嵌套（离开恢复外层、任务外只跑 `fn`）。
  ④ 的解析器改为返回 `{taskId, checkpointId}`（宿主接 `setTaskContextResolver(currentTaskContext)`），
  `file_preimages.checkpoint_id` 落值；⑦ `listPreimages({checkpointId})` + `rollbackPreimages({taskId?, checkpointId?})`
  （两者都给 = 只回本任务的一步；都不给 → `invalid-input`）。**78 例（⑤）/ 13 例（④）**，含真实 worker 两步写作 →
  只回第二步、再整任务回滚还原。**边界**："哪算一步"由调用方/产品判定（机制只认 checkpoint 标记）；
  `open` 未关闭的 checkpoint 由回滚或巡检收尾。
- **模块 ⑤ 任务运行时已落地第六片（2026-11-09，步级回滚触发入口）**：模块 API **`rollbackTask({store, port, taskId, checkpointId?, reason?})`**
  + 独立工具 **`task_rollback`（R1，四项风险基线）**（不塞 `task_control`，避免把 stop/pause 一起抬风险）；
  端口 **`CheckpointRollbackPort`**（`rollback({taskId, checkpointId?})`），⑦ 用 `createPreimageRollbackPort(store)` 实现（结构契约，AR33）。
  语义：只动本任务写入集合、按 checkpoint 逆序还原；关掉范围内仍 `open` 的 checkpoint（`committed` 保持）；写 `task.rollback` 事件；
  **不改任务状态、不删任务新建文件**；端口缺失 → `rollback-failed` 大声失败。① 侧 `CONTROL_COMMANDS` 加 `rollback`，
  `TaskControlPort.control` 增可选 `checkpointId`，**rollback 分支绕 live 闸**（任务已结束正是后悔场景）。
  **83 例（⑤）/ 84 例（①）/ 18 例（⑦）/ 13 例（④）**，含 ①→⑤「终态任务仍可回滚」与真实 worker 两步写作。
  **边界**：步边界判定归调用方/产品；签名卡片回滚按钮归 v1.1。
- **模块 ③ 审批与授权已落地第一片（2026-11-10，Grant 生命周期与复验）**：`plugins/governance/src/grants/`
  （`schema_migrations(module='grant', v1)`）——`grants` 表补 `kind`（本次 / 本会话 / 永久）、`consumed_at`（一次性兑付）、
  `policy_version`（AR37 复验项）；`ux_grants_source` 保证一次确认只产生一张授权。模块 API `create` / `get` / `find` /
  `list` / `revoke`（幂等）/ `revokeAll`（击杀开关，AR20）/ `verify({actorId, required, grantId?, policyVersion?, consume?})`；
  复验顺序 `not-found → actor-mismatch → revoked → consumed → expired → policy-version-mismatch → scope-mismatch`，
  scan 模式跳过已撤销 / 已兑付并回报最具体原因，`consume:true` 只兑付 `once`。**授予是 Web 管理面动作（AR26），不注册模型工具**。
  **25 例通过**。**边界（已随 AR37 闭环补齐）**：① 经注入式 `GrantCheckPort` 调 `verify`，动作常量 `task.wake`
  定义在 ①，③ 仍不新增表；扫描模式只看 live 授权，已撤销回报 `not-found`（同为"不复验通过"）。
  **Web 管理面已落（③ 第三片，2026-11-10）**：`plugins/governance/src/web/grants-admin.ts` —— `/admin/grants` 路由
  （exact 集合 + prefix 成员），挂到 dsh `ctx.webServer.register`（`{kind, path, handler}` 同形），**不注册模型工具**（AR26）；
  端点：`GET /admin/grants`（可 `actorId` / `includeRevoked` / `includeConsumed`）、`POST /admin/grants`（授予）、
  `POST /admin/grants/:id/revoke`、`POST /admin/grants/revoke-all`；`GET` + `Accept: text/html` 返回自包含管理页外壳
  （**无服务端数据**、CSP `default-src 'none'`、前端全 `textContent`）；认证注入 `AdminAuthorizer`，默认
  `DSH_WFXM_ADMIN_TOKEN` Bearer（未配置即 401，fail-closed），宿主可换 Web 会话身份；写操作要 `x-dsh-wfxm-admin: 1`
  （CSRF）+ JSON content-type，请求体上限 64 KiB（413 仍 drain）；授予/撤销写 ④ `append`
  （`grant.create` / `grant.revoke` / `grant.revoke_all`），**审计失败 500 `audit-unavailable` 不假装成功**；
  挂载走 cordis 的 `ctx.inject(['webServer'])` + `ctx.effect`（路由随子 fiber 卸载，不依赖不存在的 `dispose` 事件）。
  **20 例（③，`verify-grants-admin`，含 apply 挂载接线）**。**边界**：审批卡片签发 `source_approval_id` 的闭环与卡片内联按钮归 v1.1；
  宿主 Web 会话身份替换默认 Bearer 令牌；端点暂用 `/admin/grants`，与 docs/15 §五 表的 `/grants` 语义一致，`GRANTS_ADMIN_PATH` 一处可改。
- **模块 ① 渠道网关已落地第七片（2026-11-09，项目解析器片 2）**：`plugins/gateway/src/project-resolver.ts` —— 纯函数，
  信号顺序 `explicit → anchor → sticky → single → ask`，**不读正文做语义猜测**；`ProjectLookupPort` 由宿主注入 ⑥ 模块 API（AR33，① 不读 ⑥ 表）。
  `ingestInbound` 增 `/use <alias>` / `/projects` 旁路（`bypass_reason='project'`）与 `ambiguous-project` 反问（**任务歧义优先**）；
  `route_decisions` **v7** 加 `project_id` / `project_matched_by`；粘性写 `session_routes.project_id`
  （`setSessionProject`，无 route 行返回 `false`，不臆造 session）；⑤ `tasks` **v4** 把 `v_task_anchors` 扩到**六列**（`project_id`）供锚点继承。
  **83 例（①）/ 75 例（⑤）**。**边界**：`ProjectLookupPort` 的真实装配（⑥ store → 端口）与"按项目装配上下文"（13 §2.2）在片 3。
- **AR37 唤醒闭环已落地（2026-11-10，③ 第二片 / ⑤ 第七片 / ① 第八片）**：
  ⑤ 新增模块 API **`wakeTask({taskId, reason?})`**——唯一受控终态出边（不写进 `ALLOWED_TRANSITIONS`），只允许 `succeeded`
  且必须仍有未释放 `task_threads` 订阅；事务内 `round + 1`、`attempt=0`、清空租约/起止时间，写 **`task.woken`** 事件；
  非 succeeded / 无 live 订阅 → `conflict`，未知任务 → `not-found`。① 新增注入式 **`GrantCheckPort`** / **`TaskWakePort`**
  （`plugins/gateway/src/wake.ts`，`WAKE_ACTION='task.wake'`，① 不导入 ③/⑤ 包）：锚点命中 `succeeded` 且三端口齐全时
  **先复验、通过才唤醒再把回复投进新轮次**，`route_decisions` 记 **`wake`**（`gateway` **v8** 重建表扩动作白名单）；
  复验不通过 **不 attach、不进任务**，按无主消息交前台（AR37）；端口缺失保持 `finished-needs-grant` 标记（fail-closed）；
  `wake` 抛错 → `inbox=failed` + `wake-unavailable`。**88 例（①）/ 88 例（⑤）/ 27 例（③，含三模块端到端）**。
  **边界**：唤醒仍由"人在锚点上回复"触发，主动巡检/定时唤醒未做；签名卡片上的"继续"按钮归 v1.1。
- **模块 ① 渠道网关已落地第九片（2026-11-10，配对码 + 传输错误结构化）**：`schema_migrations(module='gateway', v9)` 新增
  `pairing_codes`（只存 sha256 哈希、5 分钟 TTL、`consumed_at` 一次性）；模块 API `mintPairingCode` / `consumePairingCode`
  （事务内建 actor + 绑定）；`ingestInbound` 未配对分支识别 `/bind <code>`，**任何失败一律回落静默拒绝**（不泄露配对系统存在，14 §四）；
  `port.ts` 新增 `isTransportError` 结构性检查，dispatcher 改用它（跨插件 TransportError 形状语义保留，AR32/33 的正确修法）。
  mint 入口暂为 CLI（`plugins/gateway/scripts/pairing-mint.mjs`），Web 管理面归后续。**100 例（①）**。
- **飞书渠道适配器已落地（2026-11-10）**：`plugins/feishu`（`@dsh-wfxm/feishu`）——长连接入站（WSClient + EventDispatcher
  注入式 SDK，`im.message.receive_v1` → 按 14 §三 归一化，bot 消息丢弃防环，start 20s 超时大声失败）；
  `createFeishuTransport` 结构吻合 ① `OutboxTransport`（**零 import gateway**，AR33）——寻址 replyToMsgId→chatId/openId→`resolveChatId`、
  4000 字分段（不断代理对）、错误分类（限流→rate-limited / 权限→rejected / 5xx·网络→unavailable）；凭据从
  `~/.dsh/integrations/dsh-feishu/config.json` + `~/.dsh/.credentials.yaml` 的 secretRef 解析；`createFeishuRuntime` + name/inject/apply 缝。
  **31 例 + 全仓回归全绿**；真实冒烟：长连接已连通收到 ready（`plugins/feishu/scripts/feishu-smoke.mjs` 手动），
  **消息收发回路待 owner 发一条真实消息后重跑闭环**。**边界**：卡片 / card.action.trigger / 审批回调归 v1.1；文件/图片/语音未做。
- **worker 真实执行器已落地（2026-11-10）**：`plugins/executor`（`@dsh-wfxm/executor`，⑤ 保持不依赖 dsh）——`createDshExecutor`
  spawn `dsh --profile headless --json -`（prompt 走 stdin），解析 NDJSON（`turn_end` 定成败，dsh 出错也退 0），exit≠0 按 stderr
  归 transient/permission_denied/unknown，超时 SIGTERM→SIGKILL 归 transient，租约丢失杀子进程归 conflict；
  **一次 attempt = 一个 checkpoint**（execute 顶部 begin、结束 committed/aborted，begin 失败不 spawn），env 带
  `DSH_WFXM_TASK_ID/CHECKPOINT_ID/ATTEMPT` 跨进程归因桥；④ 新增 `createEnvTaskContextResolver()` 并在 apply() 自接线
  （宿主 ALS 接线可后覆盖）；headless profile 已启用 credentials 插件。**17 例 + 真实冒烟 8/8**：真实模型写文件、断言过、
  R3 快照闸捕获、`file_preimages` 落 task_id+checkpoint_id。**边界**：⑦ `captureWorkspace` 不能冻空目录（rename ENOENT，待 ⑦ 补）；
  重试不续 `--session-id`；子进程内逐步 checkpoint 不可再细分（进程内仍归 ALS 路径）；模型凭据缺失归 permission_denied 终态。
- **切片 C 已落地（2026-11-10）：`plugins/host`（`@dsh-wfxm/host`）是唯一组合根** —— 只做装配与生命周期，不含业务规则；
  **不导入 executor/feishu**（由入口注入），只组合 ①/⑤/③/⑥。`createWfxmHost({dbPath, executor, transport, ...})` →
  `{ingest, pump, runWorkerOnce, start, stop, close}`：① 返回 `orchestrator` 时交给**前台**，`createHostPorts` 把
  `TaskRelayPort`/`TaskControlPort`/`TaskReceiptPort`/`TaskWakePort`/`GrantCheckPort`/`ProjectLookupPort` 落到公开 API，
  `onSent` 在回执送达后除 `settle` 外**再用 `external_msg_id` 建 `anchor` 订阅**（#10）。**本片前台是确定性规则前台
  `createRuleForeground`**（同 thread 有 live 任务 → `enqueueInput`，否则建 R1 任务 + `bindThread(default_owner)`；
  **前台绝不执行**，满足 §九 #11）；真实 `orchestrator` preset 归下一片。
  **同批修掉真实缺口**：⑤ worker 成功路径原先直接 `transition(to:'succeeded')` **绕过 Verifier**，现改调 `completeTask`
  （R2+ 无断言 → `criteria-required`、断言 fail/skipped → `verification-failed`，均终态、不重试）。
  `plugins/host/scripts/verify-host.mjs` **18 例**（假 transport + stub executor + 真 sqlite）覆盖 #2/#3/#5/#6/#9/#10/#11、
  AR37 fail-closed、AR13 前台失败、AR32/33 静态扫描；`scripts/e2e-smoke.mjs` 为真实冒烟入口（需 owner 发一条飞书消息）。
  **不想在飞书手打校验码时**用 `scripts/dev-web.mjs`（dev-only）：`webdev` 本地通道 + 回环 transport，
  其余全是真的（① ingest → 前台 → ⑤ worker → 执行器 → Verifier → 回执 → outbox），页面 `http://127.0.0.1:8787`；
  默认 stub 执行器，`DSH_WFXM_DEV_EXECUTOR=dsh` 换真实 dsh headless，`DSH_WFXM_DEV_RESET=1` 清库重来；
  启动时会自动绑定一个本地 owner 并授予 `task.wake`，所以「回复回执」能演示 AR37 第二轮（生产授权仍走 ③ 管理面）。
  **不需要任何人手输消息的全链路验证**用 `scripts/verify-live.mjs`（2026-11-11）：入站注入、其余全真
  （① ingest → 前台 → ⑤ worker → 执行器 → Verifier → ack/回执 → ① outbox → **真实飞书 API**，判定依据是拿回 `om_` 消息 id）；
  自建隔离库 `.wfxm/live/`，无需 `/bind`；`--dsh` 换真实 dsh headless，`DSH_WFXM_CHAT` 指定落到哪个会话。
  该脚本当场抓到并修掉两个真缺陷：① ack 的 `reply_to` 误用事件 id（飞书 99992354 拒收，改取 `content.externalMsgId`）；
  ② 任务终态后 `default_owner` 不释放，同会话下一条消息永远绑定失败（`bindThread` 改为只抢占**终态** owner 的槽位、
  保留 live 订阅以支撑 AR37 唤醒与回滚，`release_reason='superseded'`）。回归：host 19 / tasks 90 / gateway 100 /
  executor 17 / snapshot 18 / feishu 31 / live 6 全绿。
  **依赖注意**：host 的 `node_modules` 是手建软链（`@dsh-wfxm/*`、`typescript`、`@types/node`），根 `node_modules/@dsh-wfxm`
  也是手建（供 `scripts/` 下脚本解析），**均不动 `pnpm-lock.yaml`**；host 与 executor 一样没有 build 脚本，改动后需手动
  `node plugins/executor/node_modules/typescript/bin/tsc -p plugins/host/tsconfig.json`（`verify-host.mjs` 会在 lib 过期时自建）。
  **边界**：无真实 orchestrator 会话、无卡片回调、无主动唤醒；R3 冒烟仍受 ⑦ 空目录 ENOENT 限制。
- **切片 D 已落地（2026-11-11）：真实 orchestrator 前台（决策引擎版）`plugins/orchestrator`（`@dsh-wfxm/orchestrator`）** ——
  规则前台「每条消息都建任务」的结构性错误被替换成「一轮模型决策」：`① ingestInbound → target=orchestrator` 后跑
  **一次零工具 dsh 会话**，模型只输出一个 JSON（`reply` / `task` / `queue`），**由我们解析校验再执行** →
  `reply` 直接回话、`task` 建任务（R0/R1）、`queue` 排进同线程活任务；**前台仍然绝不执行**（AR25 / #11）。
  - **决策是数据不是工具调用**：`parseDecision` 是唯一裁判（未知 action / 非 JSON / 空字段 / R2·R3 / 超长
    reply>4000 与 intent>500 一律拒绝）；模型无法自我提权，因为没有工具可调。
  - **零工具靠 dsh `--patch` 叠加**：`assets/frontdesk.patch.yml` 换 persona 并 `disabled: true` 掉全部 `tool-*`
    （bash/pwsh/jobs/fs/fs-search/working-directory/web/skill/todo/goal/subagent/subagent-fork/workflow/agent-team）；
    第二层是子进程强制 `DSH_PERMISSION_MODE=read-only`。**未 fork dsh、未建新 profile、未动 lockfile**。
  - **降级显式**：`ForegroundOutcome` 增可选 `note`；决策失败/被拒 → 规则前台 + `route_decisions` 记
    `orchestrator-fallback: <reason>`；未配置 fallback → 抛错 → host 按 AR13 标 inbox `failed`（不静默丢消息）。
  - **host 接缝**：新增 `foregroundFactory?: (stores) => ForegroundHandler`（`foreground` 优先，其次 factory，最后规则前台），
    因为前台要读 ⑤ 的同线程活任务而 stores 在 host 内部创建。
  - **同线程有活任务时的活任务语义**：模型想再开任务 → 转为该任务的补充输入（避免抢 `default_owner` 槽位，#9）。
  - 验证：`node plugins/orchestrator/scripts/verify-orchestrator.mjs` **24 例**（fake dsh 校验 argv/NDJSON/超时/崩溃/缺二进制）；
    真实 dsh 三次决策冒烟 ~3–4s/次（你好→reply、看看磁盘占用→R0 task、清理日志→R1 task）；
    dev-web 用 `DSH_WFXM_FOREGROUND=orchestrator` 实测「你好」不建任务、「看看磁盘占用」建任务并回执。
  - **接线**：`scripts/dev-web.mjs` 与 `scripts/e2e-smoke.mjs` 走 `DSH_WFXM_FOREGROUND=orchestrator` 开关，
    **默认仍是规则前台**；`scripts/verify-live.mjs` 保持规则前台（它是确定性链路自检，不该引入模型抖动）。
  - **边界**：无持久会话（每轮一次冷启动 ~3–4s）；模型工具面仍未注册进 preset（`task_submit`/`say` 仍是宿主代码路径）；
    卡片回调与主动唤醒未做（R0 快问直答见切片 E）。回归：host 19 / tasks 90 / gateway 100 / executor 17 / snapshot 18 / feishu 31 / orchestrator 24 全绿。
- **切片 E 已落地（2026-11-11）：只读快问直答通道（规则先于模型）** —— 解决「看看磁盘占用」这类问题不该等一次任务：
  - `plugins/svcops/src/inspection/resources.ts`：`createResourceProbe({ runner })` 只读 `df -P -k /`、`/proc/meminfo`、`/proc/loadavg`，
    返回 `{diskUsedPct, memAvailablePct, load1, cpuCores}`，**每个值 fail-soft 为 null**（读不到就不许猜）。实测本机 **11ms**。
  - `plugins/orchestrator/src/quick-answer.ts`：**确定性第一手**（docs/17 原则 2）。只有「短（≤40 字）+ 单句（无逗号/然后/顺便）+
    提到资源名词（磁盘/内存/负载/cpu/使用率）+ 有询问词（看看/多少/占用/状态…）+ 无动作词（重启/清理/删除/部署…）」才命中；
    任务进度类同样命中并从 ⑤ 读同线程 live 任务作答。命中 → 直接 `reply`（`note: quick-answer:resources|tasks`），**不跑模型、不建任务**。
  - **不确定就让位**：探针缺失 / 全 null / 抛错 / 多句 / 含动作词 → 一律落回模型决策（不猜、不静默降级成本地假答）。
  - 接线：`scripts/dev-web.mjs` 与 `scripts/e2e-smoke.mjs` 的 orchestrator 前台注入 `probe: createResourceProbe({ runner: spawnRunner })`；
    新增根 `node_modules/@dsh-wfxm/svcops` 软链（不改 lockfile）。
  - 实测端到端（dev-web，真实 dsh 决策 + 真实探针）：`看看磁盘占用` **22ms** 直接回「磁盘已用 83% · 内存可用 72.5% · 负载 0.45（24 核）」，
    `workers.tasks=[]`；`把磁盘清理一下` 仍走模型（5.06s）→ `task-created`。
  - 回归：orchestrator **30**、svcops-inspection **27**，其余 6 套件不变全绿。
- **切片 F 已落地（2026-11-11）：常驻会话与提示缓存** —— 决策轮不再每轮冷启动：
  - 实测拆账：一轮 3.6s 里 **2.3s 是 dsh 启动/装配**（首个 `session` 事件之前），只有 1.1s 是模型。
  - 改用官方 `@deepseek-ai/dsh-sdk-client`（**钉 `0.2.1-rc.2`**）的 `DeepSeekHarness`：`--profile sdk` 走 JSON-RPC over stdio，
    **一个常驻子进程 + 固定会话**回答所有决策轮；`plugins/orchestrator/src/sdk-runner.ts`（`ResidentTurn` / `createDshSdkTurn` /
    `createSdkDecisionRunner`）+ `runner-factory.ts`（`createDecisionRunner({kind})` 默认 `sdk`，`headless` 留作逃生口与 A/B）。
  - **代价记明**：该依赖拉入 538 个包、`pnpm-lock.yaml` +9159 行；不自实现协议层是刻意的取舍（见 spec F1）。
  - **零工具仍是结构保证**：新增 `assets/frontdesk.sdk.patch.yml`（persona + 全部 `tool-*` + **`plan-mode`**，
    真机发现后者单独注册 `exit_plan_mode`，不是 `tool-*` 命名）+ `DSH_PERMISSION_MODE=read-only`；
    真机 `request/header` 复核 `tools=[]`。顺带修掉既有漏洞：headless 叠加里删 `tool-agent-team`（rc.2 已无此条目），
    补 `tool-subagent-control` / `tool-subagent-list-agents`。
  - **失败即丢弃**：dsh 运行时不支持取消，超时/报错一律 `close()` 子进程并外抛（前台按 AR13 降级、`route_decisions` 留痕），
    下一轮重新装配，绝不复用被污染的会话；`warm()` 启动即预热（用户不付启动费）。
  - 实测 A/B（同机同句「你好」）：headless 2.74s/2.76s → 常驻 **1.00s/1.35s**（约 2.7×）；只读问题仍 20ms 直答。
  - 回归：orchestrator **39**（新增常驻 7 例 + 真跑 `--dump-config` 断言两个 profile 无启用 `tool-*`）、
    svcops-tools **25**（修好一处既有红例：`apply` 早已改 `ctx.effect`，测试仍在断言 `dispose` 事件），其余套件全绿。
  - **边界**：无取消、无缓存命中度量（事件无 usage 字段）、单会话历史靠 profile 自带压缩、preset 工具面仍为空。
- **切片 G 已落地（2026-11-11）：飞书卡片回调与审批按钮（互动面）** —— 审批闭环按 14 §五/§六 打通，**卡片只是视图、正本在 `approvals`（AR10）**：
  - ③ `plugins/governance/src/approval/store.ts` 新增 `setExternalMsgId`（发卡后回填被渲染的消息 id，供后续 patch；未知 id → false）。
  - ① 新增协议中立 `plugins/gateway/src/approval.ts`：`parseCardAction`（接受 `approval_id`/`approvalId`、`approve|approved`、`reject|rejected`、`details`）
    与注入式 `ApprovalAnswerPort`；`ingestInbound` 的 `card_action` 分支走端口——非决策动作只 `ignore` 不消费 nonce、端口缺失/抛错 `approval-unavailable`
    fail-closed、`!ok` 记 `inbox=failed(code)` 且不假装成功、`ok` 记 `done` 并带 `status`。`ErrorCode` 增 `approval-unavailable`。
  - 飞书 `plugins/feishu`：`normalizeFeishuCardActionEvent`（`card.action.trigger` → ① 形状，`operator.open_id` + `context.open_message_id`）；
    `src/card.ts` 渲染审批卡（`approval_card`，header `需要确认 · R2/R3` + 批准 primary / 拒绝 default，按钮 value 含 `approval_id`/`decision`/`nonce`/`channel_id`）
    与结果卡（`approval_result`，绿/红、无按钮）；`transport` 对 `approval_card` 发 `msg_type:interactive`、对 `approval_result` 调 patch（无 patch/失败回退文本）；
    `channel` 仅在提供 `onCardAction` 时订阅 `card.action.trigger`（否则 warn 不订阅）。
  - host `plugins/host/src/host.ts`：`requestApproval({level,summary,impact,threadId,chatId?,taskId?,ttlMs?})` → ③ `create` + `outbox(topic='approval.card')`；
    `onSent` 对 `approval.card` 用 `approvals.setExternalMsgId` 回填；点击成功后入队 `approval.update`（`kind:'approval_result'`，带 `externalMsgId` 以便 patch），
    `dedupeKey='approval-update:<id>'`；未挂 ③ → `requestApproval` 抛 `approval-unavailable`（fail-closed）。
  - **同批修掉 `schema_migrations` DDL 漂移**：gateway/tasks/knowledge/svcops 建 `PK(module)`，而 ③/⑦ 建 `PK(module,version)`，`CREATE TABLE IF NOT EXISTS` 让先开者决定；
    同库先开 ③ 再开 gateway 时 gateway 的 `ON CONFLICT(module)` 报错。gateway 迁移改为 **`DELETE`+`INSERT`（每模块一行）**，不再依赖 `ON CONFLICT` 目标。
  - 验证：`verify-host` **22**（发卡→onSent 回填→点批准→③ `approved`→patch、二次点击 `not-pending` 且只一条 patch、未挂 ③ fail-closed）、
    `verify-gateway` **104**（新增 4 例：端口 ok / `not-pending` / 抛错 fail-closed / 非决策不消费 nonce）、`verify-feishu` **43**（卡片 1–6 + 回调 toast 2c–2f）、
    `verify-approvals` **25**（含 P1 六例）；`scripts/check-invariants.mjs` 与逐包 `tsc --noEmit`（gateway/governance/tasks/knowledge/host/feishu/snapshot/orchestrator）全绿。
  - `scripts/e2e-smoke.mjs --approval`：首条消息后发一张审批卡到该会话，供 owner 真实点击。
  - **真机冒烟已跑通（2026-11-11）**：点「批准」→ `card:result ok:true/status=approved`、`approval.update` `sent`、**回读飞书 API 该卡标题=`已批准`**（`msg_type=interactive`）。
    同批修掉真机缺陷：`card.action.trigger` 回调必须返回 `{toast}`（否则飞书客户端报「操作失败」），通道现按 sink 结果返回 success / warning（重复点击「该审批已处理」）/ error。
  - **边界**：不做 R2/R3 自动审批闸（点批准只改 ③ 状态与 patch，不自动继续任务）、不做「看详情」按钮（`details` 只忽略）、不做签名/验签（长连接已鉴权）、不做按钮级角色授权。
- **切片 H 已落地（2026-11-11）：部署与运行（16 SSOT）** —— 「dev 脚本能跑」变成「能长期稳定运行的常驻服务」，每步都真跑：
  - **启动序列库 `scripts/lib/startup.mjs`**（生产与验证同一路径）：`parseServeConfig`（纯 env，无 yaml；`dataDir` 默认 `/var/lib/dsh-wfxm`）、
    `acquireInstanceLock`（`serve.lock`，`O_EXCL` + pid 存活判定 + 陈旧锁回收；活锁 → **退出码 3**）、`runStartup`（八步，`[startup] N/8 <step>`）、
    `assertModules`（八项必需导出一个不缺）、`assertZeroToolAsset`（`frontdesk*.patch.yml` 启用项不得残留 `tool-*`，仅允许 `tool-result-pruner`）、
    `writeReadiness` / `removeReadiness`（best-effort，失败也能释放锁）。**退出码：0 正常 / 1 自检失败 / 3 已有实例**。
  - **生产入口 `scripts/serve.mjs`**：头部 `delete process.env.LD_LIBRARY_PATH`；`--check` 跑完八步即退（供 `release verify` 与还原演练复用）。
    装配 ①/⑤/③/⑥/⑦ + `createDshExecutor` + `createWfxmHost`；`foregroundFactory` 按 `DSH_WFXM_FOREGROUND` 选规则或 orchestrator（`createDecisionRunner` + `warm()` + 真实探针）；
    渠道 `loopback` 或真实飞书（无绑定时 `mintPairingCode` 打印 `/bind`）；`onCardAction` 返回 `{ok, toast}`；`SIGTERM/SIGINT` → `host.stop()` → 最多 3 轮 flush →
    断通道 → `close()` → 删 readiness → 释放锁 → exit 0；常驻用 `setInterval` 保活。
  - **`deploy/systemd/dsh-wfxm.service`**：`User/Group=dshwfxm`、`EnvironmentFile=/etc/dsh-wfxm/env`、`HOME=/var/lib/dsh-wfxm/home`
    （`ProtectHome=yes` 下 dsh 的可写落点）、`Restart=on-failure` + `StartLimitIntervalSec=300/Burst=5`、`TimeoutStopSec=30`、`UMask=0077`、
    `NoNewPrivileges/ProtectSystem=strict/ProtectHome/CapabilityBoundingSet=`、`ReadWritePaths=/var/lib/dsh-wfxm /var/backups/dsh-wfxm`。**无 `ExecReload`**；
    `deploy/systemd/dsh-wfxm.env.example`（无密钥）、`deploy/polkit/50-dshwfxm.rules`（只放行 `subject.user==="dshwfxm"` + `unit.startsWith("dsh-wfxm-managed-")`）。
  - **`scripts/release.mjs`**（`prepare/verify/switch/rollback/list/current/gc`，默认根 `/opt/dsh-wfxm`）：release 自包含（`EXCLUDES` node_modules/.git/.wfxm/releases/current/coverage，
    相对 symlink 保留），依赖树同盘 `cp -a --link` 硬链、跨盘回退复制；`verify` 跑 **release 自己的** `serve.mjs --check` 并断言 `@dsh-wfxm/gateway` realpath 在该 release 内；
    `switch` 校验必需文件后 tmp symlink + rename，**拒不完整版本**；`gc` 永不删 `current`；`systemctl restart` 由运维执行（不给发布脚本 root）。
  - **`scripts/backup.mjs` + `scripts/restore-drill.mjs`**：`VACUUM INTO`（WAL 折入）+ `memory/ snapshots/ outbox-files/ (+config)` 同 tag → `manifest.json`（counts/components）→
    `tar.gz` + `.sha256`；restic 可选（未配即打印 `restic: skipped`，**不静默假装异地已备**）。演练先校验 hash → 解包 → `integrity_check` + 逐表行数比对 + 组件存在 →
    **在还原目录跑完整八步并断言 `8/8`**；篡改 hash / 缺 manifest / 行数不符 / 空数据目录均**拒绝**。
  - **验证**：`verify-serve` **12** / `verify-deploy` **5**（含 `systemd-analyze verify`）/ `verify-release` **7** / `verify-backup` **6**；全仓 29 套件全绿、`check-invariants` OK、逐包 `tsc --noEmit` 12/12。
  - **一键门禁**：`scripts/build.mjs`（逐包 tsc；`--noEmit` 只 typecheck）、`scripts/check-style.mjs`（CRLF/空白/末尾换行/`debugger`/`.only(`/`console.log`）、
    `scripts/verify-all.mjs`（显式 `SUITES` + `discover()` 漂移检测，`--ci` 跳过真机套件）。`live` 套件通过 `DSH_WFXM_FEISHU_CONFIG`/`DSH_WFXM_CREDENTIALS`
    读 `/etc/dsh-wfxm/credentials/*`，root 也能跑全量。CI 见 `.github/workflows/ci.yml`（Node 24 + pnpm 11.28.5）。
  - **对话连续性（Slice AO）**：`gateway.threadHistory` 只取本线程的 `message` + 已发送 `say`（脱敏、旧→新）；
    决策 prompt 带最近 8 轮，SDK 按 `threadId` 开独立 session；补充指令走 `tasks.steerTask`——
    running/paused 打断重跑（intent 追加、attempt 归零、清租约，host 调 `worker.cancel()`），queued 合并，
    waiting_* 记录；输入 `delivered`，claim 时 `read`。终态任务仍走 AR37 复验。
  - **消息去重（AO.1）**：① 在 triage 前比较同线程紧邻上一条用户消息，文本相同且
    ≤ `DSH_WFXM_DUPLICATE_WINDOW_SECONDS`（默认 60，0 关闭）即忽略——不建任务、不投递、
    不打断、不回执；仅 `kind='message'`，control/卡片动作永不去重。
  - **任务执行上下文（Slice AP）**：⑤ `recentThreadResults(taskId, 2)` 取同线程 `succeeded`
    回执（排除自身），worker 组装最多 2 条 / 每条 300 字的 `threadContext` 交给执行器，
    executor 拼在 `intent` 之后同 stdin 送入；只读 ⑤ 自己的表，读取失败不阻塞执行。
  - **重启会话续接（Slice AQ）**：`runOnThreadSession` 在 `session "<threadId>" already exists`
    时 `resumeSession` 并重试一次；其他错误不恢复，仍丢弃运行时并降级（AR13）。
  - **等待输入闭环（Slice AR）**：执行器约定 `[[NEED_INPUT]] 问题` → `needs_input`（checkpoint
    `aborted`）→ ⑤ `parkForInput` 落 `waiting_input` + `task.input_requested`（问题在事件里，
    不建表）→ host `pump()` 向 live 线程追问一次（按事件 seq 去重）→ 用户回复经 `steerTask`
    追加 intent 并回 `queued`（`attempt=0`），worker 下一轮继续；不写终态、不写回执。
  - **富媒体输入输出（Slice AS）**：入站 `image`/`file`/`audio`/`media`/`post` 归一化为
    `content.attachments`（保留 `raw`），渠道用 `messageResource.get` 落盘到
    `<dataDir>/attachments/<msgId>/`，正文后追加本地路径（语音注明未启用转写）；
    单附件失败不丢消息。出站 transport 支持 `kind:'file'|'image'`（先上传素材、再发说明、
    再发媒体消息），永久失败降级文本；回执超 `DSH_WFXM_SPILL_CHARS`（默认 600，0 关闭）
    写 `<dataDir>/outbox-files/` 并作为附件发送，写入前 `redactedText`；执行器 `[[ATTACH]] <path>`
    （仅 cwd 内、≤3、≤20MB）经 worker `onArtifacts` 由 host 入队 `task.artifact`。
    **真机验收（2026-11-19，`2026.11.19-2`）**：文件与截图均落盘并进入任务；文件用 `read`
    读出标记，截图被正确描述。同批修复 `readRoots` 未含 `attachments` 与未知大小误显示「0 字节」。
  - **邮件（Slice AU / J1）**：新增 `@dsh-wfxm/mail`（`mail_search` / `mail_read` 两个 R0 只读工具，
    挂 headless profile；前台不挂）。后端是 `scripts/mail-query.py`（Python 标准库 `imaplib`），
    IMAP 只读、密码走 stdin；配置在 `~/.dsh/integrations/dsh-mail/config.json` + `secretRef`。
    `dsh-email` 因部署机无 pnpm/npm 无法安装，发送（J3）另议。
  - **提醒（Slice AT / J5）**：新增 `@dsh-wfxm/reminder`（`reminders` 表，一次性/每天/每周）；
    前台新增 `remind` / `reminders` / `cancel_remind` 三种结构化动作（时间二次校验，过去即追问）；
    host pump 按 `reminder:<id>:<dueAt>` 幂等入队 `say`，周期推进只跳第一个未来时刻；
    不做待办清单与「到点执行任务」。
  - **变更台账（Slice AV / ⑦ changes）**：新增 `@dsh-wfxm/changes`（`changes` 表，`applying→applied→verified→kept`
    / `applying→failed` / `applying|failed→rolled_back`）；⑤ 的 R2/R3 执行前经结构端口 `begin`
    （按 `task_id` 幂等，R3 带 `snapshotId`），Verifier 通过 `keep`，终态失败 `markFailed`；
    `begin` 失败即拒绝执行（`change-record-failed`）。host 启动先 `recoverChanges()`（已成功只补账，
    其余按快照/前镜像回滚，失败留痕不重试）再 `worker.recover()`。**不注册** `svc_*` 写工具，
    `kind='service'` 只留表结构（见 [11 §5.4](docs/11-架构锚定.md)、[16 §12.38](docs/16-部署与运行.md)）。
  - **检索自检（Slice AW / J6）**：`scripts/verify-search.mjs` 断言 headless profile 实际挂载
    `dsh-web-search-deepseek` / `dsh-web-fetch-http` 与 provider/超时；`--live` 才跑真实查询，
    默认不进 CI。文档见 [09 J6](docs/09-能力对照与实现路径.md)。
  - **项目级授权（Slice AX / E3）**：`config/project-tools.json` 按 `project_id` 列工具白名单
    （`exec_*` 通配）；执行器注入 `DSH_WFXM_PROJECT_ID`，③ 的 `pre-execute` 拒绝白名单外工具
    （`rule='project-tool'`）。文件缺失=不限制，格式错误=fail-closed（[11 §5.2](docs/11-架构锚定.md)、[16 §12.39](docs/16-部署与运行.md)）。
  - **IM 全局停止（Slice AY / H4）**：IM 发 `全局停止`/`halt` 写停止文件（`DSH_WFXM_HALT_FILE`，
    默认 `$DSH_WFXM_DATA_DIR/KILL`；工具调用即拒）、中止运行中尝试置 `paused`、停新任务与提醒；
    `全局恢复` 解除，跨重启保持。
    停止期间控制命令与 outbox 仍工作；不撤销 Grant、不自动重跑（[11 §5.3](docs/11-架构锚定.md)、[16 §12.40](docs/16-部署与运行.md)）。
  - **授权唤醒闭环（Slice AZ / H6 / AR37）**：宿主编排注入当前 `policy.yaml` 版本，唤醒复验补齐
    `policy_version` 与项目 `domain`；授权未记录版本或版本漂移一律 `policy-version-mismatch`（fail-closed）。
    ③ 扫描模式改读该 actor 全部授权，撤销回报 `revoked`；管理面发放省略 `policyVersion` 时自动落当前版本。
    验证：`verify-grants 30` / `verify-grants-admin 21` / `verify-gateway 124` / `verify-host 57`。
  - **健康告警**：`scripts/health-alert.mjs` + `dsh-wfxm-health.{service,timer}`（2 分钟，进程外检查 `systemctl is-active`），
    主服务 `OnFailure=` 兜崩溃循环；同状态 30 分钟冷却、状态变化立即发；不替 owner 重启（见 [16 §12.29](docs/16-部署与运行.md)）。
  - **边界**：systemd 实际创建用户与装 unit **需 root**（文件已静态校验）；**真实 `serve` 飞书长连接 + 消息闭环已跑通**（2026-11-11：`/bind` 配对 → 真实消息 →
    建任务 → 真实 dsh 执行 → 回执，拿回真实 `om_` id，连续 16 分钟无 warn/error，`SIGTERM` 退出码 0，见 [16 §12.4](docs/16-部署与运行.md)）；
    蓝绿回滚**只做手动**（不做自动切回）；
    docker socket proxy / metrics·OTel / journald 配置 / 备份自动轮转**未做**；迁移失败**不自动恢复**（靠备份 + 人工）。逐项见 [16 §十二](docs/16-部署与运行.md)。
- **环境坑已回写 [16 §十](docs/16-部署与运行.md)**：Trae 等宿主注入的 `LD_LIBRARY_PATH` 会让 better-sqlite3 加载旧 `libstdc++` 失败——
  跑 dsh/node/pnpm 前必须 `unset LD_LIBRARY_PATH`。
- **切片 I 已落地（2026-11-11）：审批闸（R2/R3 执行前必须先确认）** —— 把「审批卡只是装饰」补成真闸：
  - **⑤ 两个受控方法**（`plugins/tasks/src/store.ts`）：`holdForApproval`（条件更新 `queued → waiting_approval`，非 queued 抛 `conflict`，写 `task.waiting_approval` 事件）、
    `resumeFromApproval`（`waiting_approval → queued` + 清租约 + `next_attempt_at=now`，写 `task.resumed`；二次调用返回 `{resumed:false,reason:'not-waiting'}` 而非抛错）。
    两者都是 `wakeTask` 同例的**受控例外**，不改 `ALLOWED_TRANSITIONS`；恢复只回 `queued`，绝不直跳 `running`（租约必须由 claim 拿）。
  - **host 风险闸**（`plugins/host/src/host.ts`）：`task-created` 且 `riskLevel` 为 R2/R3 → 立刻 `holdForApproval` + `requestApproval`（level 直接映射 `R2/R3`，`chatId/channelId` 取 `result.thread`）；
    ack 改「已发确认卡片，批准后开始执行」。**未挂载 ③ 或无 thread → fail-closed 取消并回执**（AR13），绝不裸跑。
  - **审批结果唤醒**（`plugins/host/src/ports.ts`）：`ok:true` 后重读 ③ 正本取 `taskId`（不信卡片 payload）→ `approved` 调 `resumeFromApproval`、`rejected` 调 `transition(paused)`；
    `ok:false`（重复点击/过期/nonce 已用）绝不碰任务。`ApprovalAnswerReport` 增可选 `taskId/taskStatus`，由 ① 原样透传到 `IngestResult.approval`；
    卡片 patch 文案改为「已批准，任务继续执行」/「已拒绝，任务已暂停」。`HostPortDeps.now` 让端口层与 host 共用同一时钟（测试可钉死）。
  - **验证**：`verify-tasks` 90 → **94**（hold/冲突/worker 不领/恢复可领取/二次恢复幂等/未知任务）；`verify-host` 22 → **28**（R2 挂起+卡片+ack / 批准后执行成功 / 拒绝保持 paused / 二次点击不重复恢复 / R1 不受影响 / 无 ③ fail-closed）；
    `verify-gateway` **104**、`check-invariants` OK、`verify-serve` 12/12、逐包 `tsc --noEmit` 全绿。
  - **边界**：批准授权的是**整个任务**而非某条命令；恢复＝重新排队后重跑执行器（headless 一次性，**接不上原 dsh 会话**）；R3 二次确认、「看详情」、按钮级角色授权**未做**；
    `tools.start/resume` 直跳 `running` 不带租约的既有怪异**不在本片修**。
- **部署已上线（2026-11-11）：release `2026.11.11-1` 在 `192.168.16.58` 上 `enabled + active`** ——
  执行记录与复现手册见 [`tasks.md` 末尾「接续作业：部署收尾」](tasks.md)，真机证据见
  [16 §12.6](docs/16-部署与运行.md)。两个真机缺口已修复：unit 的 `SystemCallFilter` 需追加
  `landlock_create_ruleset landlock_add_rule landlock_restrict_self`（否则 dsh 报 `SANDBOX_UNAVAILABLE`）；
  服务 HOME 的 profile 内 `@dsh-wfxm/*` 必须指向 `/opt/dsh-wfxm/current/plugins/*`（相对软链在
  `ProtectHome` 下会断，dsh 静默跳过 governance/svcops）。
  约束不变：**别跑 `pnpm install`、别动 `pnpm-lock.yaml`、别 `git reset/checkout/clean`**（工作区有大量未提交改动），
  构建/发布一律 `sudo -u ailearn -H`，任何 node 命令前 `unset LD_LIBRARY_PATH`。
- **切片 J 已上线（2026-11-11）：定时巡检 + 日报（G2/G3/G6）** —— 把 `svc_inspect` 从「人叫」变成「宿主主动跑」：
  - **`plugins/svcops/src/patrol.ts`**：`readPatrolConfig`（`DSH_WFXM_PATROL_INTERVAL_MINUTES` 默认 15、`DSH_WFXM_DIGEST_HOUR` 默认 9、
    `0`/`-1` 分别关闭巡检/日报，非法值回落默认并告警）+ `createInspectionPatrol`（`start/stop/runOnce`）。
    `runOnce` 采集 → `store.save` → `gradeInspection`；`immediate` 按失败项组合做 **30 分钟静默**，日报按
    `dedupeKey=patrol-digest:<target>:<YYYY-MM-DD>` **每天一次**；投递异常只 `logger.warn`。
  - **`scripts/serve.mjs`**：`host.start()` 后启动巡逻，`deliver` 取最新活跃 binding 的 `externalUserId`，
    走 ⑥ `enqueueOutbox({topic:'say', payload:{openId}, dedupeKey})`；无绑定记 `patrol:warn` 丢弃；`shutdown` 先 `patrol.stop()`。
  - **验证**：`scripts/verify-patrol.mjs` **8/8**（默认值 / 关闭开关 / 非法值 / 空日报 / 首推+静默+重推 / 日报每日一次 / 09:00 前不推 / 投递抛错隔离 / 不装定时器），
    `verify-serve` 12/12、`check-invariants` OK。
  - **生产**：release `2026.11.11-2`，服务 `active`；首轮 `patrol cycle ok (pushed digest)`，`inspections` 1 条 `ok`，
    `outbox.status=sent`（`om_x100b60769bd7a0a4de55af1561ea1be`）。配置表与边界见 [`docs/16 §九之一`](docs/16-部署与运行.md)，记录见 [`tasks.md` Slice J](tasks.md)。
  - **边界**：静默窗为进程内状态（重启靠 `dedupeKey` 兜底）；日报只覆盖巡检，**任务/会话日报未做**；不做自动修复。
- **切片 K 已上线（2026-11-11）：R2/R3 审批执行打通（C6 真闭环）** —— 把「卡片批准后仍跑不了服务操作」补成端到端可执行：
  - **规则层风险升级**（`plugins/tasks/src/risk.ts`）：`planTaskRisk(intent, baseline)` 只在基线 R0/R1 且命中「起/重启托管服务」时升到 R3，
    并**自动附模板断言** `service_active(unit)`——既守住「无判据不 R2+」，也不让模型提权（模型仍只能提 R0/R1，规则只升不降）。
    `managedUnitFor` 认显式 `dsh-wfxm-managed-*.service`（需含起/重启动词）与「重启 <name> 服务」；stop、容器、普通名词不升级。
    宿主两条前台（`plugins/host`、`plugins/orchestrator`）创建任务都用它，note 写 `risk-escalated:svc-start:<unit>`。
  - **执行器交接**（`plugins/executor/src/executor.ts`）：claim 后只对 R2/R3（＝已走完审批）注入 `DSH_WFXM_APPROVED_LEVEL`；
    R0/R1 显式删除该变量，防止继承泄漏。
  - **工具级审批桥**（`plugins/governance/src/index.ts`）：同时有 `DSH_WFXM_TASK_ID` 与 `DSH_WFXM_APPROVED_LEVEL=R2|R3` 时注册
    `approval/request` answerer，**只对 `svc_*` 返回 `allowed-once`**，其余 `next()` 交回原策略（默认 fail-closed）。
  - **提权改走受控 wrapper**：本机 polkit 0.105 **不解析 JS 规则**（0.106 才有 JS backend），原 `50-dshwfxm.rules` 实际不生效。
    新增 `deploy/bin/dsh-wfxm-unit-control`（verb / 托管前缀 / 字符集三重校验）与 `deploy/sudoers/dsh-wfxm-unit-control`
    （唯一一条 NOPASSWD 规则）；`svcops` 写操作读 `DSH_WFXM_UNIT_CONTROL` 走 `sudo -n …`，读操作仍走 `systemctl`。
    `install.sh` 安装 0755 wrapper 与 0440 sudoers（写前 `visudo -cf` 预检）。
  - **复验**：`scripts/serve.mjs` 给 worker 传 `verify.serviceStatus`（systemd `activeState`），`service_active` 断言可执行。
  - **验证**：`verify-risk` **12**、`verify-approval-bridge` **7**、`verify-host` **29**、`verify-orchestrator` **40**、`verify-executor` **18**、
    `verify-svcops` **15**、`verify-svcops-tools` **25**、`verify-deploy` **7**；回归 tasks 94 / inspection 27 / approvals 25 / policy 10 / serve 12、`check-invariants` OK。
  - **生产**：release `2026.11.11-4`；以 `dshwfxm` 跑真实 headless dsh，`svc_restart dsh-wfxm-managed-demo.service` 返回 done，
    `ActiveEnterTimestamp` 由 `18:00:15` 变为 `18:01:03`。边界：批准授权整个任务；R3 二次确认 / 看详情未做。
- **切片 L 已上线（2026-11-11）：R3 二次确认与「看详情」（审批体验）** —— 把「误点一次就放行高风险」补成两段式，并让审批卡可自解释：
  - **③ 正本**（`plugins/governance/src/approval/store.ts`）：迁移 v2 增 `confirm_stage/confirm_actor/confirm_at`；
    `migrate()` 改为按版本顺序推进。R3 的 `approved` 首击只写 `confirm_stage=1`（**不决定、不消费 nonce**）并返回 `confirm-required`；
    再次点「批准」仍是 `confirm-required`；只有专用 `confirmed`（且与首击同一 actor）才落 `approved`。R2 一击生效，拒绝仍是一击。
  - **① 只读分支**（`plugins/gateway/src/ingest.ts`）：`details` 不再「忽略」而是调用 `approvalDetails` 端口并写 route decision，
    **不碰 ③、不消费 nonce**；`confirm-required` 是预期中间态（inbox `done`，不是 failed），结果带 `stage`/`nonce`。
  - **宿主两张卡**（`plugins/host`）：新 topic `approval.detail`（独立详情卡）与 `approval.confirm`（patch 原卡为确认卡）。
    详情数据由 ③ 记录 + ⑤ 任务/断言合成（`approvalDetail` 端口），批准/确认统一走 `resumeFromApproval`。
  - **飞书**（`plugins/feishu`）：审批卡第三键「看详情」；详情卡蓝 head、无按钮、注明只读；确认卡红 head、「确认执行」`decision: confirm`；
    `approval.confirm` patch 失败回退文本（`patchApprovalCard` 泛化为 `patchCard`）。
  - **验证**：`verify-approvals` **38**、`verify-gateway` **106**、`verify-host` **30**、`verify-feishu` **47**；
    回归 tasks 94 / executor 18 / snapshot 18 / orchestrator 40 / svcops 15·25·27 / governance 其余 7 套 / serve 12 / release 7 / deploy 7 / invariants 11 全绿。
  - **生产**：release `2026.11.11-5`（迁移前 `VACUUM INTO` 备份），`schema_migrations(approval)=2`，服务 `active`、`NRestarts=0`。
    边界：详情卡不带决策按钮；确认态沿用整体 `expires_at`；换人确认未开放；按钮级角色授权与验签未做。
- **切片 M 已上线（2026-11-11）：任务日报（主动摘要）** —— 补 `docs/05` G3 缺的「任务日报」：
  - **纯函数**（`plugins/tasks/src/digest.ts`）：`summarizeTaskDigest(tasks, {from,to,maxLines})`。窗口语义：已结束按 `finishedAt`、
    在跑五态是「现在」快照；`createdAt > to` 剔除；空窗口返回 `null`（不推 0 任务噪音）。文本表头固定顺序，bullets 先结束后在跑，
    `taskRef` 优先、id 前 8 位兜底，intent 单行 40 字截断。
  - **调度复用**（`plugins/svcops/src/patrol.ts`）：新增 `taskDigest` 回调，挂在既有「每天一次」digest 闸内，**独立消息**
    dedupeKey `task-digest:<YYYY-MM-DD>`；抛错只 `warn`，当天不重试、不影响巡检与告警。
  - **组合根**（`scripts/serve.mjs`）：`taskDigest` 读 `host.stores.tasks.listTasks()`，⑤ 拥有数据、组合根只读；无新表/新配置。
  - **验证**：新增 `verify-digest` **11** 例；`verify-patrol` **12** 例（窗口、双 dedupeKey、空摘要、抛错隔离、未到点不调用）；
    回归 tasks 94 / risk 12 / svcops 15 / tools 25 / inspection 27 / serve 12 / invariants 11 全绿。
  - 边界：不做逐任务 token/耗时；`listTasks()` 无 `since`（数据变大后需在 ⑤ 加时间过滤）；会话摘要由切片 N 承接。
- **切片 N 已上线（2026-11-11）：会话日报（结构化，无正文/无模型）** —— 补 G3 的最后一块：
  - **① 只读窗口**（`plugins/gateway/src/store.ts`）：`InboxFilter` 增 `since`/`until`，有窗口时走独立 SQL（含 status/channel 组合），
    不再为一次日报全表拉 `inbox`。
  - **纯函数**（`plugins/gateway/src/digest.ts`）：`summarizeConversationDigest({threads,messages,tasks,window})`。只统计 `kind='message'`，
    按 `threadId`（缺失回退 `chatId`）分组；任务按 `createdAt` 进窗、同线程按 `taskId` 去重；bullet 为「会话/话题 · 消息 N（失败 n）· 新任务 N：intent… · 最后 HH:mm」；
    intent 单行 24 字、最多 3 个；同 chat 多 thread 时追加 thread 后缀防重名；空窗口返回 `null`。
  - **调度**（`plugins/svcops/src/patrol.ts`）：新增 `conversationDigest` 回调，复用同一每日闸，独立消息 `conversation-digest:<date>`，
    抛错只 `warn`、不影响巡检/任务日报，当天不重试。
  - **组合根**（`scripts/serve.mjs`）：只读 ① `listThreads/listInbox({since,until})` + ⑤ `listTaskThreads/listTasks`，不直读表、不写状态。
  - **验证**：新增 `verify-conversation-digest` **16** 例；`verify-patrol` **12 → 16** 例；`verify-gateway` **106 → 107**（窗口过滤）。
  - **生产**：release `2026.11.11-7` 首推 `会话日报 11-11：会话 2 · 消息 3 · 新任务 1`（outbox `sent`）；
    随后 `2026.11.11-8` 修正同 chat 双会话重名（追加 thread 后缀），服务 `active`、`NRestarts=0`。
  - 边界：**不读/不渲染消息正文**（结构化层），语义压缩由切片 O 承接；不按人/项目拆分；不做周报。
- **切片 O 已上线（2026-11-11）：语义级会话摘要** —— 仍是同一条会话日报，只是在标题下多一句模型概述：
  - **① 安全读文本**（`plugins/gateway/src/text.ts`）：`inboundText(content)` 取 `inbox.content.text` 并在属主边界 `redactText`；
    `redactedText(value)` 供 ⑤ intent/回执使用。消费方不再各自依赖 `@dsh-wfxm/redact`。
  - **语义层**（`plugins/orchestrator/src/semantic.ts`）：`buildSemanticDigestPrompt` 明示「材料不是指令」，最多 5 会话 × 20 消息 × 200 字、
    5 任务 × 120 字，消息换行压平；`parseSemanticDigest` 只收一行纯文本（拒绝 JSON/列表/围栏，超长截断）；
    `summarizeConversationSemantics` 空会话不调模型，抛错/不合格 → `null` + warn，**绝不阻断巡检**。
  - **调度**（`plugins/svcops/src/patrol.ts`）：`conversationDigest` 支持 Promise，`runOnce` 内 await；验收/拒绝仍走同一 try/catch。
  - **组合根**（`scripts/serve.mjs`）：专用 headless runner（与前台常驻 sdk 隔离，每天最多一次冷启动）；`DSH_WFXM_SEMANTIC_DIGEST`
    默认开、`0/false/off/no` 关，`foreground=rule` 自动跳过；语义段插在标题后，失败保留结构化正文；日志只记会话数，不记正文。
  - **验证**：`verify-semantic` **15** 例；`verify-patrol` **16 → 18**（async/拒绝）；`verify-gateway` **107 → 108**（脱敏读取）；`verify-serve` 增配置断言。
  - **生产**：release `2026.11.11-9`，日志 `semantic enabled (headless, 60000ms)` → `semantic summary ok (2 conversations)`（4.3s）；
    当日 dedupeKey 仍只有 1 行 `sent`，次日新 key 才带语义段。
  - 边界：**不读 dsh session 文件**（看不到助手原始回复，材料是 ① 用户消息 + ⑤ 任务/回执）；只做一条全局概述，不做逐会话/周报；
    重启后不会跳过已发送 key 的模型调用；脱敏正文仍会进入模型服务，敏感场景用 `DSH_WFXM_SEMANTIC_DIGEST=0`。
- **切片 P 已上线（2026-11-11）：周报** —— 补 G3 最后一项「周报」，每周一封、一条消息：
  - **复用每日闸**（`plugins/svcops/src/patrol.ts`）：`PatrolConfig.weeklyDay`（默认周一，`-1` 关闭）+ 内存 `lastWeeklyAttempt`；
    不新增调度器/表/模型调用；dedupeKey `weekly-digest:<ISO周>`（`isoWeekKey`，如 `2026-W46`）。
  - **内容归属**：⑦ 用 `formatInspectionWeek` 渲染近 7 天巡检段（次数/状态/持续项 ≤3 条）；⑤/① 复用日报纯函数并加可选
    `title`（`任务（近 7 天）` / `会话（近 7 天）`），组合根 `weeklySections` 拼接，svcops 不 import 其他模块类型。
  - **周报日取代日报**：周报成功发出即置 `lastDigestDay`，当天不再发巡检/任务/会话日报；周报为空/异常时回落日报（不回退成静默）。
  - **验证**：`verify-patrol` **18 → 23**（ISO 周跨年、巡检周段、配置开关、取代日报、异常隔离/非周报日/未到点不调用）；
    `verify-digest` 12、`verify-conversation-digest` 17；回归 gateway 108 / host 30 / feishu 47 / orchestrator 40 / tasks 94 / svcops 15 / serve 12 / invariants OK。
  - **生产**：release `2026.11.11-10`（`active`、`NRestarts=0`），启动日志 `patrol every 15min, digest 9:00, weekly day 1`；
    合成运行（loopback + `DSH_WFXM_WEEKLY_DIGEST_DAY=3`）`patrol cycle ok (pushed weekly)`；真机首个周一由 `docs/06 §六` 观察。
  - 边界：窗口固定「近 7 天」、不按自然周对齐；不按项目/人拆分；**不做语义周报**（不读正文、不调模型）。
- **切片 Q 已上线（2026-11-12）：出站失败可见** —— 重试耗尽不再静默丢：
  - **① 只读统计**（`plugins/gateway/src/store.ts`）：`outboxHealth({since,now})` → `failed`（窗口内）/ `pending` / `retrying` /
    `oldestPendingAgeMs`；纯 SELECT，不改投递语义、不新增表。
  - **分级日志**（`plugins/gateway/src/dispatcher.ts`）：排定重试 → `warn`（id/topic/attempt/nextRetryAt/错误），耗尽 → `error`；
    只记 id/计数，不记 payload。host 把 logger 注入 dispatcher（无 `error` 时降级到 `warn`），serve 输出 `host:warn` / `host:error`。
  - **日报/周报一行**（`plugins/svcops/src/patrol.ts` + `scripts/serve.mjs`）：`outboxDigest` 在巡检日报末尾、周报附加段之后追加
    `出站：失败 N · 积压 M`（重试 >0 时附 `（重试 K）`）；异常只 warn，不影响正文。
  - **验证**：`verify-gateway` 108 → 111、`verify-host` 30 → 31、`verify-patrol` 23 → 26；回归 feishu 47 / orchestrator 40 /
    tasks 94 / svcops 15 / serve 12 / invariants 11。
  - **生产**：release `2026.11.12-1`（`active`、`NRestarts=0`）；当日 `outboxHealth` 24h = `失败 0 · 积压 0`（日报 key 已由旧 release 去重，行内容次日 09:00 可见）。
  - 边界：行只给计数与最老积压年龄（不列具体消息/正文）；不自动重投 `failed`（`outbox_retry` 仍由人触发）；不新增消息类型。
- **切片 R 已上线（2026-11-12）：长任务可见** —— `running` 任务不再长时间静默：
  - **⑤ 只读快照**（`plugins/tasks/src/store.ts`）：`latestEvent(taskId)`；host 用 `listTasks({status:'running'})` +
    `listTaskThreads({liveOnly:true})` 组装 `RunningTaskSnapshot`（default_owner 优先）。
  - **① 进度公告**（`plugins/gateway/src/task-progress.ts`）：里程碑取「当前已达最高一档」（默认 2/10 分钟，
    `task-progress:<taskId>:<ms>`），stall 默认 15 分钟无新事件（`task-progress:<taskId>:stall:<seq>`，新事件后可再提醒一次）；
    `findOutboxByDedupe` 前置去重；payload 带 `text`，飞书 transport 零改动。
  - **host pump** 顺序 receipt → progress → dispatch（当轮入队当轮投递）；`HostPumpReport.progress` 可见
    `scanned/enqueued/skippedNoThread/skippedDuplicate`；无线程/线程不在 ① `threads` 的任务跳过。
  - **配置**：`DSH_WFXM_TASK_PROGRESS`（默认开）、`DSH_WFXM_TASK_MILESTONES`（默认 `2,10`）、
    `DSH_WFXM_TASK_STALL_MINUTES`（默认 `15`，`0` 关闭）；不改状态机、不暂停任务、不新增表/调度器。
  - **验证**：`verify-gateway` 111 → 115、`verify-host` 31 → 34；回归 feishu 47 / orchestrator 40 / tasks 94 /
    svcops 15 / patrol 26 / serve 12 / invariants OK；gateway/host `tsc` 全绿。
  - **生产**：release `2026.11.12-2`（`active`、`NRestarts=0`），启动日志
    `progress {"milestonesMin":[2,10],"stallMin":15}`；真机 >2 分钟任务的提醒由 `docs/06 §六` 验证。
- **切片 S 已上线（2026-11-12）：巡检快问扩展** —— 只读问题继续在毫秒级直答，不再花模型决策：
  - **匹配**（`plugins/orchestrator/src/quick-answer.ts`）：显式 `*.service` / `dsh-wfxm-managed-*` / `<英文名> 服务`
    → 托管 unit；含「端口/port」+ 数字 → 端口；「错误/报错日志」→ 条数（默认 15 分钟）。
    仍要求 ≤40 字、单句、无动作词；无目标（「看看服务状态」）与今天/昨天/7 天窗口一律落回模型。
  - **探针**：`QuickChecks` 的 `unitStatus` / `listeningPorts` / `logErrors` 由 serve/dev-web/e2e 注入 ⑦ 现有探针；
    缺方法/抛错/`unknown` → `null` 落回模型；端口只有 `ss` 成功读取后才敢说「没有监听」。
  - **边界**：只答托管 unit（⑦ `systemd.status` 的 `not-allowed` 不放开）；只答日志条数不答正文；不改 ⑦/① 代码、无新表/配置。
  - **验证**：`verify-orchestrator` **40 → 46**；回归 host 34 / gateway 115 / svcops 15 / inspection 27 / patrol 26 /
    serve 12 / invariants OK；真实探针冒烟 `22 端口` 与 `15 分钟错误日志` 均直答。
  - **生产**：release `2026.11.12-3`（`active`、`NRestarts=0`），已安装 release 冒烟通过；
    真机飞书提问项见 `docs/06 §六`。
- **切片 T 已上线（2026-11-12）：运维加固** —— 备份从「有脚本」变成「每天真的跑」：
  - **保留策略**（`scripts/backup.mjs`）：`--keep N` / `DSH_WFXM_BACKUP_KEEP`（默认 `7`），`0` / `--no-prune` 关闭；
    只清理 `dsh-wfxm-YYYYMMDDTHHMMSSZ.tar.gz` 与其 `.sha256`，其他文件不动；非法值显式失败。
  - **定时备份**（`deploy/systemd/dsh-wfxm-backup.{service,timer}`）：oneshot、`dshwfxm`、同一 env、
    `ProtectSystem=strict` + `ReadWritePaths=/var/lib/dsh-wfxm /var/backups/dsh-wfxm`；
    每日 03:30 + 15m 随机延迟、`Persistent=true`。
  - **日志上限**（`deploy/journald/10-dsh-wfxm.conf`）：500M / 50M / 30day；`install.sh` 仅在内容变化时重启 journald。
  - **安装**：只 `enable dsh-wfxm-backup.timer`，不 `--now`；首次备份由 timer 或人工 `systemctl start` 决定。
  - **验证**：`verify-backup` 6 → 9、`verify-deploy` 7 → 11；回归 `verify-serve` 12 / `invariants` OK。
  - **生产**：release `2026.11.12-5`（`active`、`NRestarts=0`）；手动一次备份 `Result=success`，
    `prune: kept 1, removed 0 (keep=7)`，timer 次日 03:30 左右；保留策略的人工观察见 `docs/06 §六`。
- **切片 U 已上线（2026-11-12）：B4-b 工作区隔离 Phase 1** —— 任务从「共用一个 workdir」变成
  「按项目解析 + git 任务一任务一 worktree」：
  - **字段**：`tasks` v6（7 列 + 两索引）、`projects` v3（`vcs/prepare_cmd/worktree_root/merge_mode`）；
    只有 ⑤ 的 `setIsolation()` 写隔离列，`worktree` 缺 path/base/branch → `invalid-task`。
  - **判定**（`plugins/tasks/src/isolation.ts`）：git 干净仓库 + 仓库根 = 项目根 → 建
    `<root>/.agents/worktrees/<task_ref>` 与 `wfxm/<task_ref>` 分支；非 git / 脏 / 非仓库根 → serial。
  - **prepare**：`/bin/bash -lc <prepare_cmd>` 只跑一次（10 分钟超时）；失败、目录丢失、中断一律显式
    失败，不重建、不回落共享 workspace。
  - **执行**：executor `workdirResolver` 支持异步；worker 结算前重读任务，verifier cwd 跟随 worktree。
  - **开关**：`DSH_WFXM_WORKTREE_ISOLATION` 默认 **false**（15 §10.8）；关闭时行为与 Slice T 完全一致。
  - **验证**：新增 `verify-isolation` 10/10；`verify-tasks` 94 / `verify-knowledge` 45 /
    `verify-executor` 19 / `verify-serve` 12 / `verify-host` 34；`invariants` OK。
  - **生产**：release `2026.11.12-6` 迁移完成；`projects` 当前为空且开关关闭，任务行为不变。
  - **未做**：`resource_locks`、自动合并/PR、项目登记 UI。
- **切片 V 已上线（2026-11-12）：B4-b 合并与清理 Phase 2** —— worktree 任务现在能真正收尾：
  - **合并**（`plugins/tasks/src/merge.ts` 的 `createIsolationService.merge`）：手动、同仓库串行
    （进程内队列 + `<git-common-dir>/wfxm-merge.lock`）；只接受 `succeeded` 且
    `merge_state ∈ {none,conflict}`；主仓库与 worktree 都必须干净；`merge_mode=pr` 拒绝本地合并。
  - **冲突**：收集 unmerged paths → `git merge --abort` → `merge_state=conflict` + `task.merge` 事件；
    任务保持 `succeeded`（终态不回退，owner 2026-11-12 确认），CLI 退出码 2。
  - **释放/保留期**：`release` 幂等（第二次 `alreadyReleased`），`merged` 才删分支；放弃/失败保留分支。
    `prune` 只清终态、`merge_state ∈ {none,merged}`、默认超过 7 天的目录，`conflict/pending` 不动。
  - **入口**：`scripts/isolation.mjs status|merge|release|prune`；不依赖开关，关闭后仍可收尾已有 worktree。
  - **验证**：新增 `verify-merge` 10/10；回归 `verify-isolation` 10 / `verify-tasks` 94 /
    `verify-knowledge` 45 / `verify-executor` 19 / `verify-serve` 12 / `verify-host` 34 /
    `verify-deploy` 11 / `verify-backup` 9；`invariants` OK。
  - **生产**：release `2026.11.12-7`（`active`、`NRestarts=0`）；`tasks` v6 保持，`projects` 为空、
    开关关闭，未造任务。
  - **未做**：`resource_locks`、PR 模式执行、自动合并/解决冲突、`wfxm/*` 分支生命周期（Phase 3）。
- **切片 W 已上线（2026-11-12）：项目登记入口** —— `projects` 表终于有可审计的写入口：
  - **入口**：`scripts/projects.mjs add|list|update|remove`；只写 ⑥ 的 `projects`，不读隔离开关、
    不建任务、不建 worktree。登记只是「允许」，启用仍由 owner 决定。
  - **校验**：`--root` 必须存在且为目录（登记 `realpath`）；git 按 `<root>/.git` 探测，显式
    `--vcs git` 但无仓库即拒；`--worktree-root` 必须在 root 内；`--merge-mode pr` 要求 git 且
    `git remote` 非空；重复 name / 重复 root 拒绝，`add` 不会 upsert 覆盖既有项目。
  - **update / remove**：`update` 只改提供的字段（`--prepare-cmd ""` 清空、`--worktree-root ""`
    回默认）；名字是身份，不支持改名。`remove` 归档（`list` 默认隐藏、`--all` 可见），重复幂等。
  - **验证**：新增 `verify-projects-cli` 10/10；回归 `verify-knowledge` 45 / `verify-isolation` 10 /
    `verify-merge` 10 / `verify-serve` 12；`tsc -p plugins/knowledge` 与 `invariants` OK。
  - **生产**：release `2026.11.12-8`（`active`、`NRestarts=0`）；`projects` 仍为 0、隔离开关未设置，
    未登记任何项目。
  - **下一步**：「是否登记生产项目并打开隔离」与 `resource_locks` 片，均待 owner 拍板/排期。
- **切片 X 已上线（2026-11-12）：非文件资源锁** —— worktree 管不到的端口 / DB / unit / docker / git
  合并，现在有租约表可串行：
  - **迁移**：`tasks` v7 新增 `resource_locks`（`resource_key` / `task_id` / `lease_owner` /
    `lease_expires_at` / `released_at`）+ live 唯一索引 + TTL 索引。
  - **API**：`createResourceLockService`（acquire / heartbeat / release / releaseByTask / list）；
    `acquire` 多键同事务、全有或全无，争用返回 `conflict` + 持有者，不抛异常。
  - **键规范化**：`port:<proto>:<port>` / `db:<realpath>` / `unit:<name>` / `docker:<project>` /
    `git:<repoRoot>`；非法前缀、缺失路径、非仓库根一律拒绝。
  - **生命周期**：worker 在 Verifier 之后释放该任务全部租约（成功/失败/重试）；`stale-lease`
    不释放；进程崩溃由 TTL（默认 300s，可心跳续租）兜底。
  - **验证**：新增 `verify-resource-locks` 12/12；`verify-tasks` 94（迁移断言更新到 v7）、
    `verify-isolation` 10、`verify-merge` 10、`verify-executor` 19、`verify-knowledge` 45、
    `verify-serve` 12、`invariants` OK。
  - **生产**：release `2026.11.12-9`；表为空、`projects=0`、开关关闭，任务行为不变。
  - **未做**：任务计划 `resources` 声明与自动申请（验收 #5 端到端仍待接线）、`merge` 切到
    `git:<repoRoot>` 表锁（Slice Z 已补）、资源锁 CLI / 看板（Slice AA 已补）。
- **切片 Y 已上线（2026-11-12）：计划声明资源 + 自动 acquire** —— 资源锁真正接进执行路径：
  - **声明**：`task.plan.resources`（字符串数组）是唯一来源；`createTask` 创建时校验，
    非法键 → `invalid-task`；`task_submit` 新增可选 `resources`。
  - **申请**：开关打开时 worker 在 R3 快照之后申请全部键；争用 → `deferTask()` 回 `queued`
    （`attempt - 1`，不烧重试），写 `task.deferred`（含阻塞键/持有者）。
  - **心跳/失租**：`keepAlive()` 同时续任务租约与资源租约，并作为执行器 `hooks.heartbeat`；
    资源丢失 → 执行器终止，结算按 `conflict` 失败（fail-closed）。
  - **释放**：Verifier 之后释放该任务全部租约；`stale-lease` 不释放；崩溃由 TTL 兜底。
  - **开关**：`DSH_WFXM_RESOURCE_LOCKS` 默认 **false**（15 §10.8）；关闭时声明被忽略，
    任务行为与 Slice X 完全一致。
  - **验证**：`verify-resource-locks` **19/19**；回归 `verify-tasks` 94 / `verify-isolation` 10 /
    `verify-merge` 10 / `verify-executor` 19 / `verify-knowledge` 45 / `verify-host` 34 /
    `verify-serve` 12；`tsc`（tasks + host）与 `invariants` OK。
  - **生产**：release `2026.11.12-10`；owner 批准后 `/etc/dsh-wfxm/env` 已设
    `DSH_WFXM_RESOURCE_LOCKS=1`。低风险 smoke 通过：任务声明 `port:tcp:65500` 被占 → `queued`
    （`attempt=0`、`task.deferred`），持有者释放后自动执行并 `succeeded`（receipt `OK`），
    结束无 live 锁；holder 任务已取消。
  - **未做**：自然语言推断资源键、未声明资源的 B 域全局串行（当前由单 worker 保证）。
- **切片 Z 已上线（2026-11-12）：merge 使用 `git` 资源锁** —— 合并从「仅文件锁」扩到租约表：
  - `service.merge()` 在文件锁内申请 `git:<realpath(repoRoot)>`（TTL 600s），再执行 `git merge`。
  - 同仓库被其它任务占住 → 每 100ms 重试到 `lockTimeoutMs`（默认 30s），超时抛 `conflict`，
    `merge_state` 不变（不误报内容冲突）。
  - 成功 / 冲突 / 异常都在 `finally` 释放；进程崩溃由 TTL 兜底；`prune` / `release` 不取该锁。
  - **验证**：`verify-merge` **12/12**（新增「合并期间租约可见/结束释放」「占用超时可恢复」）；
    其余回归全绿；发布 `2026.11.12-11`，生产无 `git:` live 残留。
  - **未做**：非本系统进程直接跑 `git merge` 的约束、跨仓库批量合并。
- **切片 AA 已上线（2026-11-12）：资源锁运维入口** —— `scripts/locks.mjs`：
  - `list [--all] [--json]`：默认 live 租约；`--all` 含已释放。
  - `release <lockId>`：幂等释放单条；`release --task <taskId|taskRef>`：释放该任务全部 live 租约。
  - 不提供 acquire（申请只属于 worker / merge）；未知任务/命令退出 1。
  - 明确 B 域串行：未声明 `plan.resources` 的任务不写 `resource_locks`，由单 worker 顺序执行；
    `verify-resource-locks` 增加「不产生锁行」用例（20/20）。
  - **验证**：`verify-locks-cli` **7/7**；`verify-resource-locks` **20/20**；其余回归全绿；
    发布 `2026.11.12-12`，release 内 `--help` 冒烟、生产 `list` 为空。
- **切片 AB 已上线（2026-11-12）：生产启用 worktree 隔离** —— owner 批准后：
  - 登记 demo 项目 `/var/lib/dsh-wfxm/projects/demo`（dshwfxm 所有，`vcs=git`、`merge=manual`）。
  - `/etc/dsh-wfxm/env` 设 `DSH_WFXM_WORKTREE_ISOLATION=1`；`active`、`NRestarts=0`、startup 8/8。
  - R0 任务（`projectId=demo`）：`succeeded`、`isolation=worktree`、
    worktree `/var/lib/dsh-wfxm/projects/demo/.agents/worktrees/<ref>`、branch `wfxm/<ref>`、receipt `OK`。
  - `isolation.mjs release --reason abandoned` 后 worktree 删除；残留分支手工删除，主仓库干净。
  - **边界**：真实仓库 `/home/ailearn/projects/dsh-wfxm` 服务用户无读/写权限，未登记；
    要启用真实项目需 owner 决定所有权/ACL/组调整。demo 可 `projects.mjs remove` 归档。
  - **B4-b 四项手工验收已完成（demo）**：双 worktree 互不影响；手动 merge（merged + cleanup）；
    冲突（退出码 2、无半合并、解决后重跑 merged）；prune（`removed 2, failed 0`、`none→abandoned`、
    conflict 不动）。详见 `docs/06` 143–146 行。
  - **R3 卡片（切片 AC，`2026.11.12-20`）**：审批卡必须 `update_multi=true`；卡片点击的下一步
    **放进回调响应**（`toCardActionResponse` 的 `card`），不要事后 `message.patch`（会与回调渲染竞争
    而被丢弃）；回调里不要 `await host.pump()`（飞书 ~3s 超时）；生产保留 `patchDelayMs=8000` 仅作兜底。
    快照必须支持空工作区（先建 `.tmp`）。`verify-feishu` 49/49、`verify-snapshot` 19/19。
  - **R3 视觉验收（2026-11-13 已完成）**：`docs/06` 116/117 已在生产 Web 端真实点击核对——批准→红头
    「R3 · 请再次确认」（红 `rgb(245,74,69)`、无弹回），确认执行→绿头「已批准」+ `nonce_consumed_at`；
    118/121/122 见该表备注（121 为无生产 R2 入口的产品缺口）。
  - **托管 unit fixture（2026-11-13）**：主机已建 `dsh-wfxm-managed-demo.service`（`sleep infinity`，已 enable），
    让 R3「重启 demo 服务」的 `service_active` 有真目标；任务 `urg85xchrk` 判据 `pass`、`succeeded`。
  - **托管服务写操作（2026-11-13 改线）**：`NoNewPrivileges=yes` 让 `sudo` 无法提权，故 `svcops` 的
    start/stop/restart 改走 **root 侧白名单 helper**（`dsh-wfxm-unit-control.service`，
    socket `/run/dsh-wfxm/unit-control.sock` 0660 root:dshwfxm，脚本在 `deploy/bin/`）；
    `env` 为 `DSH_WFXM_UNIT_CONTROL=/usr/local/sbin/dsh-wfxm-unit-client`，wrapper+sudoers 仅留兼容。
    真重启已验（任务 `ehdrcr6db8`）；`2026.11.13-3` 起模板断言是 `unit_restarted` + `service_active`
    （前者比 `ActiveEnterTimestamp` 与任务 `startedAt`，tasks schema v8，生产 `dvkqw2sjdj` 两条 pass）；
    `svc_logs` 通过把服务用户加入 `systemd-journal` 组解决（`kdumgf6gnt` 回执含 41 行真实 journal）；
    `2026.11.13-4` 修掉「日志里出现『启动是否正常』被误判成服务重启」的误升级（同请求现为 R0）。
  - **`paused` 不再算活任务（`2026.11.13-7`）**：gateway 只在结构化控制帧时锚定 `paused`；前台
    live 列表与 ⑤ 新绑定都会绕开/顶掉旧 paused owner，否则「拒绝审批」会把线程永久占死。
  - **R2 入口（`2026.11.13-9`）**：`planTaskRisk` 命中「写绝对路径文件」即升 R2 + `file_exists`；
    R2 卡单击放行（无确认步骤）。**落盘边界（`2026.11.16-2`）**：`dsh` 沙箱根 = 子进程 cwd，
    所以交付物在默认 workspace 内的任务由 `isolation.ts` 判为 `serial`、直接在该 workspace 跑
    （不建 worktree，也不放开 `danger-full-access`）；`config/policy.yaml` 的写/读根同步含该目录。
    生产任务 `7ygzjh249h` 判据 `pass`。
  - **审批过期清扫（`2026.11.13-1`）**：③ 只在点击时才落 `expired`，所以 `host.pump()` 每 tick 先调
    `approvals.expireOverdue()`，把门控任务 `waiting_approval → failed` 并 patch 灰头「已过期」；
    否则不点的审批会让任务永停并把线程占死。`verify-approvals` 42、`verify-host` 35。
- **人工验证集中清单**见 [docs/06 §六](docs/06-风险与待验证.md)：R3 两次点击、看详情只读、R2 一击、拒绝、任务日报/会话日报推送与去重、语义段落、首个周报，
  攒够一批后统一在飞书里验。

## 5. 待 owner 拍板的决策点

摘自 [08 §七](docs/08-产品能力构想.md)，阻塞级别见 [09 §四](docs/09-能力对照与实现路径.md)。**这些不是技术问题，不要替 owner 决定。**

| # | 决策点 | 阻塞级别 | 状态 |
|---|---|---|---|
| 1 | 自主 vs 确认的配比（D1 vs D7） | — | ✅ **已定**（R0–R3 + 计划级授权，见 [11 §九·补 A](docs/11-架构锚定.md)） |
| 2 | 限域范围：按操作类型分级 vs 按目录锁死 | — | ✅ **已定**（域/目录为主 + 动作风险上调，双闸取严，见 11 AR11） |
| 3 | 跨项目知识边界：默认隔离 vs 分层共享 | — | ✅ **已定（2026-11-09）：项目事实隔离、偏好共享**（写时拒带 `projectId` 的偏好；项目上下文读 = 全局偏好 ∪ 本项目事实；无上下文只读全局。已落 ⑥，45 例） |
| 4 | 管家能力是否进第一版 | — | ✅ **已定：进**（最小切片 B4/C6/G1/G2/G3/G6，见 08 §六、09 §八） |
| 5 | **服务管理范围**：systemd / Docker / 两者 | — | ✅ **已定默认：运行时探测**（有 docker 就启用，没有就摘除） |
| 6 | **巡检清单** | — | ✅ **已定默认：最小安全集**（磁盘/内存/负载/unit 失败/端口/日志错误率），owner 可后调 |

> **#1 / #2 / #4 已定；#5 / #6 由环境基线 + 运行时探测消解。开工阻塞项全部清零。**
> 选型不依赖服务器具体信息：默认按最保守集启用，探不到的能力就不启用。

## 6. 决策纪律

这个项目的历史教训：**没跑的测试不能算绿，跨切改动必须同批更新依赖它的测试**。

沿用：
- 每个验收点都要求**真实跑通**，不接受只在单测里过
- 每件交付独立、可中止；不做一次性大重构
- 声称"完成"前必须有 fresh 验证输出，不用上次的结论
- **产品决策与技术判断分开**：像"跨项目知识要不要跨"这种是产品决策，不要在实现时顺手定了
- **不用实现反推产品**：先在 08 定义能力，再去 09 评估代价