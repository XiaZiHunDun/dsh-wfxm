# 18 — Super-agent 对照与改进建议（建议稿）

> **状态**：建议稿 v2.2（2026-11-05 增补 prime-agent 参考，不改变既有结论）。**本文不修改 08/11/13/15/17 的既有结论**；
> 标为"建议"的内容在 owner 确认前不生效，标为"待拍板"的内容不替 owner 决定。
> **已定并生效**：B4 定为 **B4-b**、前台架构定为 **C 方案**（Router 作为唯一前台，见 §十一）；
> **C 方案已于 2026-11-03 回写 v2**（11/15/17/13/14/08 正文生效）；
> **B1 线程/订阅与 B4 并发写已于 2026-11-03 经 owner 确认生效 v2.1**（[11 §十三/§十四](11-架构锚定.md)、[15 §九/§十](15-数据与契约.md)、
> AR8 改写与 AR35–AR37 并入 [11 §九](11-架构锚定.md)）。**B2 主动路径（2026-11-18）、B3 Watchdog（2026-11-16）均已实施**，
> 实施记见 §四；B1–B4 全部落地，本文转为决策与实施记录。
> 本文其余章节保留写作时的 `dispatcher` 表述，作为历史对照。
> **前置**：[08 产品能力](08-产品能力构想.md)、[11 架构锚定](11-架构锚定.md)（AR1–AR37）、
> [13 核心机制](13-核心能力方案.md)、[15 数据与契约](15-数据与契约.md)、[17 Agent 侧设计](17-Agent侧设计.md)。
> **本文只回答一个问题**：对照 DeepSeek 的 Super-agent 设计与原型之后，**哪些该吸收、哪些不该、哪些必须 owner 决策**。

---

## 〇、材料与方法

| 材料 | 用途 | 局限 |
|---|---|---|
| 知乎原文 `https://zhuanlan.zhihu.com/p/2099987320443237060` | 设计主张 | 直连抓取被反爬拦截，未取到正文 |
| IT之家全文转述（2026-10-31） | 五模块、实验数字、开放问题 | 二手转述 |
| 英文技术媒体拆解（techbytes，2026-11-01） | 交叉核对概念与动机 | 二手转述 |
| `/home/ailearn/githubpro/dsh-superagent-prototype`（`docs/000–007`、`src/`、`prompts/`、`tests/`） | 机制的一手定义与边界 | **研究原型，非生产软件** |
| 本机 dsh Web 会话中对原型的介绍原文 | 第三方视角的项目概括 | 模型生成，需与代码核对 |

> **口径**：文章 = 主张（含尚未在原型落地的 Watchdog、Inline & Spill、Chain of Recall、投机执行）；
> 原型 = 已实现的定义。两者混用时本文会显式标注。原型 `docs/` 的规则比文章细得多，**以原型为准**。

---

## 一、结论摘要

1. **骨架同源，不是另一套架构**。它的 Router/Worker ≈ 我们的 `dispatcher` + 任务 worker；
   Source/Trigger/Thread ≈ 我们的网关入站 + `inbox` + 会话；它明确"Ticket 自己定义状态、不跟随 Executor Session"，
   与我们"Task 是正本、session 是执行载体"一致。
2. **我们更硬的六项不要退回去**：审计哈希链（AR15）、R0–R3 + 域/目录双闸（AR11）、
   Verifier 断言 + 前置快照 + 回滚（13 §3.1/§3.4）、双数据面 + 单一写者矩阵（AR2/AR23）、
   事实卡版本化 + 事实体检（13 §2.3/§2.5）、审批 `nonce + actor` 与渠道解耦（AR10）。
3. **真正缺的是边界语义，不是能力清单**：① **线程/订阅**——后续消息如何准确落回已有任务而不重新评估；
   ② **策略版本与准入强度**——主动性如何"先记录、后放开"；③ **长任务的外部守望**——租约只能发现"进程死了"，
   发现不了"活着但没进展"。
4. **可直接吸收 13 条（A 类）**，均不新增端口、不改对象模型；其中 A1/A3/A4/A7 是"先补语义"，
   能直接消除"说不清、等不明、为什么没理我"三类问题。
5. **需要 owner 拍板 4 条（B 类）**：Thread/Subscription、主动路径、Watchdog、per-task worktree。
   前两条动对象模型，后两条分别动 AR8 与产品边界。
6. **明确不吸收 8 条（C 类）**：公共群聊主动外发、BYOM、多租户、跨源身份推断、A2A 协商、
   v1 投机执行、"永不删除"、照抄"Router 无 Bash"。

> **一句话**：把它的"注意力成本"哲学和几条边界语义吸收进来，但**不要用它替换我们的治理与验证内核**。

---

## 二、对照矩阵

| 能力面 | 原型 / 文章 | dsh-wfxm | 结论 |
|---|---|---|---|
| 工作单元 | Trigger → Thread → Ticket → Assignment | 入站 → `inbox` → Conversation/Task → session | 同源，我们的 Task 更重 |
| 双层 | Router 作为前台：有判断、能对话、无执行；Worker 隔离执行 | `orchestrator` 前台（窄工具面）；任务 worker 独立会话 | ✅ C 方案已回写 v2（§十一） |
| 事件模型 | Source 保读取位点、去重、定义 Thread | 网关 + `inbox` 幂等 + 会话 | ⚠️ 我们缺 Thread 与 disposition |
| 准入 | Gate（确定性）+ Assessment（模型） | S1 规则 + S2 主模型 | ✅ 同源，我们多 R0–R3 |
| 授权 | Mandate：策略版本/范围/强度/命中规则；不可变 | Grant：范围/过期/撤销；审批按 plan 绑定 | ⚠️ 我们缺版本与强度 |
| 任务状态 | 阶段表 first-match-wins；Report 六值 | `tasks.status` 8 值 | ⚠️ 语义粗，缺 `ready`/`dropped` |
| 并发 | 并发上限 + 人的消息多留 1 个 slot | 租约 CAS + 队列，无优先级 | ⚠️ 缺"人优先" |
| 副作用 | Effects 先落库；同工单同会话保序 | Outbox + 租约 + ack 判据；无排序 | ✅ 我们更强，补排序即可 |
| 恢复 | 运行中派工结束，新派工带 recovery note | 租约回收 + `start_cursor` | ⚠️ 缺"先核对再重做"提示 |
| 上下文 | Inline & Spill + Chain of Recall | 分层装配 + 硬配额 + locator | ⚠️ 思想有，缺统一 recall 契约 |
| 主动性 | 规则注册表 + observe/auto + 准入表 | G 域只有定时巡检/报告 | ❌ 我们缺"事件 → 研判 → 任务" |
| 守望 | 独立 Watchdog（文章；原型未实现） | 租约 + 巡检 | ❌ 缺"无进展/偏航"判定 |
| 人机面 | 三问 + 按工作流分 Tab + 精确阶段 | Web 控制台职责清单 | ⚠️ 缺"三问"与标签定义 |
| 数据 | 单库、单一写者、生成列 | 单库 + 单一写者矩阵 + 保留分层 | ✅ 同源，我们更完整 |
| 安全边界 | 明说"不是安全边界，绝对路径可绕过" | AR11 读起来像强边界 | ⚠️ 需诚实声明 + OS 兜底 |

---

## 三、A 类：可直接吸收（13 条，不动 AR）

**判定标准**：不新增端口、不改对象模型、不改变已有不变量；只补字段、语义、流程与验收。

| # | 建议 | 机制要点（原型依据） | 落点 | 成本 | AR 影响 |
|---|---|---|---|---|---|
| A1 | 准入三档 + 准入表 + 强度 | `off / observe / auto`；`explicit / inferred / not admitted`；observe 把正向研判记成"would accept"的 ignore；接受推断候选必须过研判，且至少命中 1 条规则 | [08 G](08-产品能力构想.md#L184-L199)、[11 §5.3](11-架构锚定.md)、15 `decisions` | 中低 | 无（AR6 fail-closed 不变） |
| A2 | 策略版本 + 授权复验 | Mandate 记录策略版本；变化丢弃进行中的 Eval、给受影响活工单发 `policy-changed`，**不立即吊销**；恢复前复验；只有 accept / 人工 stop / 复验失败改授权 | 15 `grants`、[11 AR20](11-架构锚定.md#L1169)、⑤/③ | 低 | AR20 兼容，需补"变更≠撤销" |
| A3 | 阶段表 + Report 六值 | 阶段按 first-match-wins：`person/delivery`、`person/answer`、`person/review`、`person/blocked \| failed`、`working/queued`、`idle`、`working`；Report：`progress/waiting/ready/blocked/failed/dropped` | [15 `tasks`](15-数据与契约.md#L219-L245)、[11 §5.1](11-架构锚定.md#L818-L858)、客户端 | 中低 | 无，需迁移与状态机用例 |
| A4 | 结构化 Attention | worker 工具面移除 `ask_user_question/present/plugin_manager`；报告只带一个 `attention`（问题+选项+上下文+关联消息）；"等人"不从自由文本推断 | [17 §二/§四](17-Agent侧设计.md)、15 新表、③ | 低 | 无（与 H1 一致） |
| A5 | 人的消息优先 slot + noWait | 并发上限之外多留 1 个 slot 给"人的消息/状态查询"，唤醒优先于新派工；Router/Worker 前台命令 5 秒转后台；禁 `sleep`、超 30 秒 timeout、job wait 超 5 秒；后台 30 分钟上限 | 12 并发、[11 §5.1](11-架构锚定.md#L842-L856)、17 preset | 低 | 无 |
| A6 | prepare + 执行变量 + 恢复提示 | 一任务一目录；prepare 命令只跑一次（10 分钟上限，失败即任务 failed）；执行变量 key/value/description 且不含凭据；重启后新派工带"先查目录/git/外部系统，再重复外部动作" | [11 §5.6](11-架构锚定.md)、15 `tasks`、16、17 worker 提示 | 低中 | 无，补 D4/D10 |
| A7 | Disposition | 每条 Trigger 的去向：`filtered / evaluated / fanned_out / dropped` + 原因码 + 工单；面板/API 只读 | 15 ① 网关、[11 §5.3](11-架构锚定.md)、客户端 | 低 | AR23：归 ① 写；AR33 只读视图 |
| A8 | Outbox 保序 | 同工单同会话按队列顺序；前一条失败三次后放行后续并报问题；不同工单/无工单不等待 | [13 §3.2](13-核心能力方案.md#L149-L160)、15 `outbox` | 低 | 无 |
| A9 | 提示词版本化 | 每次保存生成不可变版本（全文+revision+predecessor+origin）；覆盖记录 base；升级后默认变化标 `Default updated` 并给 diff；会话记录用过的 revision；冲突保存拒绝但不丢草稿；不静默截断 | 08 N、15 `settings`/`prompt_versions`、[17 §三](17-Agent侧设计.md) | 中 | AR22/AR29 兼容，直接对冲"版本撕裂" |
| A10 | 面板三问 | ① 现在有需要我处理的事吗；② 系统健康且在 doing the right things 吗；③ 一件事从触发到结果的经过；Tab 跟工作流；标签说"等谁、等什么"；健康不占空间 | [11 §2.1](11-架构锚定.md)、08 I1、后续面板设计 | 低 | 无 |
| A11 | 安全边界诚实声明 | 明确"进程内闸防误不防恶意，绝对路径/包装脚本可绕过"；OS 用户、polkit、可选容器才是边界；验收加"绝对路径绕过"用例 | [AR11](11-架构锚定.md#L1160) 补注、16 | 低 | 补注，不改 AR11 本身 |
| A12 | 同线程合并窗口 | 1–2 秒合并；Thread 上至多一个 Eval，期间到达的并入下一批；显式 stop/审批不合并 | [11 §5.3](11-架构锚定.md)、dispatcher | 低 | 无 |
| A13 | Recall 契约 | 每个注入块带 locator；超预算落文件；压缩保留 locator 与决策理由；可沿 `conversation → task → trigger → evidence` 回读；回读走工具而非重放全文 | [13 §2.1/§2.4](13-核心能力方案.md)、[17 §3.1](17-Agent侧设计.md) | 中低 | 无 |

### 3.1 治理与授权（A1 / A2 / A11）

- **现状**：08 G 只有"定时触发/巡检/报告"，H2 只有"谁能下指令"，[11 §5.3](11-架构锚定.md) 的入站准入只有配对/白名单；
  没有"推断候选"与"只看不做"两档，也没有记录"授予时依据哪版规则"。
- **建议**：在 Policy 中加 `accept_mode + admission table + strength`，在 Grant 中加 `policy_version + matched_rules`。
  observe 模式下，正向研判不建任务，只落一条 `would_accept` 决策；切 auto 前先看这份记录。
- **为什么**：这是"自主 vs 确认"配比的**运行时旋钮**，不是又一个开关。我们 [#1 决策](11-架构锚定.md#L1187) 已定 R0–R3，
  但 R0–R3 决定"动作风险"，不决定"要不要接这单活"；两者是两个维度。
- **验收**：同一条未点名消息，在 `off / observe / auto` 下分别表现为"无候选 / 记 would_accept / 建任务"，
  且都能在面板追到原因。

### 3.2 任务语义与人工介入（A3 / A4 / A5 / A6）

- **现状**：`waiting_input` 既表示"等人答"也表示"等人评审"；没有 `ready`（有结果待评审）与 `dropped`（无需处理）；
  worker 是否能用 `ask_user_question` 未明确；重启后没有"先核对再重做"的提示。
- **建议**：存储层保留 `tasks.status`，另加**派生 stage**（first-match-wins）供面板与通知使用；
  Report 改为六值；worker 只能提交结构化 `attention`；人的追问走保留 slot。
- **为什么**：这三条都指向同一件事——**"在等谁、等什么"必须可判定**。自由文本推断"在等人"是原型明确拒绝的概念，
  也是我们面板说不清的根因。
- **验收**：六个真实场景（等人答/等评审/受阻/失败/排队/idle）在面板显示正确；并发占满时人的追问仍能被处理；
  重启演练不重复外部动作。

### 3.3 可观测、一致性与提示治理（A7 / A8 / A9 / A10 / A12）

- **现状**：被过滤的消息只在审计里；Outbox 无同会话排序；提示词没有版本与 diff；面板只列职责，没规定"先答哪三问"。
- **建议**：补 disposition、`order_key`、prompt versions、面板三问、合并窗口。
- **为什么**：这四条都是**低成本降低注意力成本**。尤其是 A9：dsh 明文承诺破坏兼容，
  "默认提示变了但没人知道"是 06 里最大的内部风险，版本化 + diff 是目前最便宜的缓解。
- **验收**：一条被过滤消息能追到规则与原因；确认语不晚于结果；改默认块后面板出 diff；
  3 条连发只触发一次分诊。

### 3.4 上下文（A13）

- **现状**：已有分层装配、硬配额、大输出 locator，但没有"每个注入块都可回读"的统一契约。
- **建议**：把 locator 从"建议"升级为**可验证约束**：注入必带、压缩必留、回读必走工具。
- **为什么**：这就是文章 Inline & Spill + Chain of Recall 的可落地部分；不需要新增存储或向量库。
- **验收**：任意一条结论能追到 evidence locator；压缩后仍能回读同一条证据。

---

## 四、B 类：结构性改动（4 条；B1–B4 均已实施）

### B1 Thread / Subscription：让"后续消息"有确定归属（最高价值）

**现状与冲突**

- [11 §5.1 硬约束 4](11-架构锚定.md#L851-L856)：**任务与会话 1:1**；[§5.3](11-架构锚定.md) 是**入站必分诊**。
- 结果：同一会话里的追问，要么续跑原任务，要么新建任务；没有"一个会话承载多件工作"的正式语义；
  已结束任务无法被同一授权唤醒。

**原型做法**（[001 §Subscription](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/001-domain.md#L37-L37)、
[002 §Two paths](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/002-authorization.md#L7-L44)）

- Thread 是一等对象，由 Source 定义；Subscription 是 Ticket ↔ Thread 的多对多关系，由 Thread 持有。
- 订阅线程上的消息**扇出到工单作上下文，绕过 Gate，但不授予任何新权限**；工单仍受自己的 Mandate 约束。
- 人话在工单 live 时**归执行器所有**，不产生 Eval；超出范围才交回一次。
- 已结束但未被人工 stop 的工单**保留订阅**；同线程人话可在**同一 Mandate** 下唤醒，无需新 Eval（恢复前复验）。
- 只有**显式引用**才允许 attach；主题相似不算。stop 只由人（面板命令）或 Eval 决定，执行器不得声称"人要求停止"。

**建议（最小切片，不一次做全）**

1. 新增 `threads` + `task_threads`；**Thread ≠ 整个聊天**，而是"话题或根消息锚点"；v1 只做飞书（Web/GitHub 后置）。
   细化设计见本文附录 C。
2. 任务创建时自动订阅其发起的 Thread；同 Thread 人话在任务 live 时直达任务（仅上下文，不授权）。
3. 任务结束且未被人工 stop 时保留订阅；同 Thread 人话唤醒同 Grant（复验通过后），**不新建任务**。
4. 跨任务/超范围的消息交回分诊；保留"显式引用才 attach"。
5. v1 **不做"无锚点的多活任务仲裁"**：同一聊天里有多件并行工作时，靠回复锚点区分；无锚点交分诊。

**代价与风险**

- 动 11 §四对象模型/§5.1/§5.3，15 新增两张表，网关与任务运行时都要改，客户端要显示订阅关系。
- **回执语义要改**：现在"每任务一次回执、重复完成不覆盖"（[11 §5.1](11-架构锚定.md#L848)），
  resume 后会需要"**每次 Assignment 一次回执**"；否则唤醒后无法再报告。这是 B1 的隐藏改动点。
- 订阅消息是**数据不是指令**，仍要过注入扫描；"绕过 Gate"只绕过"要不要接活"，不绕过内容安全。

**待定**

- 飞书"话题"与"单聊"是否都算 Thread；Web 会话是否算；一个 Thread 多任务何时放开；
  人话与任务的归属在面板上如何可见（避免"我在跟谁说话"不清）。

### B2 主动路径：事件 → 规则准入 → 研判 → 任务

**现状**：G 域是"定时 → 巡检 → 报告"，没有"环境事件 → 要不要开一单"的路径；G4"建议"是给人看的，不是候选任务。

**原型做法**（[002 §Accept mode and rules](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/002-authorization.md#L91-L105)）

- Source 产 Trigger；Gate 判断"谁能在哪个来源发起、强度多大"；Assessment 逐条判断启用的规则**恰好一次**；
  accept 需要至少 1 条命中；命中的规则进 Mandate，并作为该工单的流程/沟通要求（可覆盖默认，例如静默确认）。
- 默认 `observe`；`auto` 只对规则开放；推断候选不能是 explicit。

**建议**

- v1 只接**机器事件**：CI 失败、告警、邮件到达、owner 明确订阅的会话；默认 observe；不做公共群聊外发。
- 规则表：`kind / scope / strength / 沟通要求`；命中规则随任务进入 Grant 与 worker 提示。
- observe 的记录按日报/面板汇总，不逐条推送。

**代价与风险**：中高；08 G 要新增能力项，11 §三决策层要加"候选"概念；噪音与误报是主要风险。

**待定**：哪些事件源进 v1；observe 记录如何呈现；auto 的初始白名单。

#### B2 v1 实施记（2026-11-18，release `2026.11.18-1`）

owner 拍板结果：

- 事件源只接**主机巡检发现项**（磁盘 / 内存 / 负载 / 失败 unit / 端口 / 错误日志），不接 CI、邮件、订阅会话；
- 呈现为「即时一条摘要 + 日报汇总」，不新增推送通道；
- 全部 **observe**：只记录候选，绝不自动建任务；auto 等误报率有数据后再逐条放开。

实现：新增静态规则表 `CANDIDATE_RULES`（6 项清单，`strength` 恒为 `observe`，代码里刻意没有 auto 分支）；
`inspection_candidates` 以 `(rule_id, item_id, target)` 唯一，重复命中只累加 `seen_count`；条目恢复后自动
`resolved`，再次失败会重开；即时失败告警正文追加「已记录为候选（observe，不自动建任务）。」；日报新增
「候选：新增 N · 恢复 K · 未决 M」段与最多 5 条明细，无候选时整段省略。周报未加，避免一次改两处。

生产演练（巡检临时调到 1 分钟）：制造 `dsh-wfxm-drill-fail.service` 失败 → 首个 tick 记录候选
`failed-units` 并推送带 observe 字样的即时告警；连续两个 tick `seen_count = 2` 且无重复行；
`reset-failed` 后一个 tick 内 `status = resolved`。

### B3 Watchdog：先做确定性"无进展检测"

**现状**：租约只解决"进程死了"；G2 巡检是外部服务；没有"任务活着但原地打转"的判定。原型**未实现** Watchdog，
文章把它列为外部控制回路（基础设施错误 + 模型判断是否取得实质进展/是否偏航）。

**建议**

- v1 确定性信号：连续 N 步无新证据 / 同一工具同参数重复 / 预算余量低于阈值仍无结论 / 超过预估时长 → 任务 `paused`，
  只发一条结构化 `attention`（"卡在 X，建议 A/B"）。
- v2 再做模型判偏航；只给建议，**不直接改任务状态**（避免第二个治理者，破坏 AR23）。

**代价与风险**：确定性版本中低；模型版本高。误杀长任务（大编译、大下载）是主要风险，阈值必须可配置并能一键放行。

**待定**：阈值、是否允许自动重试一次、与 AR19 预算硬停的边界。

#### B3 v1 实施记（2026-11-16，release `2026.11.16-3`）

只落了"可观测"那一半：任务静默超过 `DSH_WFXM_TASK_STALL_MINUTES`（默认 15）→ 一条结构化
`task.progress`（`stall: true`），带 `stuckAt / stuckPhase / silentMs / elapsedMs / options`，
正文写明卡在哪个阶段，以及唯一有效的动作「停止 `<ref>`」。

**不做自动 `paused`**：当前 `paused` 只改行状态，杀不掉宿主里的 dsh 子进程；子进程随后完成时
`paused → succeeded` 是非法迁移，任务会被卡死并丢掉回执。自动暂停的前置是协作式取消
（executor 支持外部 abort），所以 v1 只提示、不代替 owner 决策（也符合 AR23 不做第二治理者）。

**信号取舍**：`task_events` 只有生命周期事件（created / started / checkpoint / …），没有逐步工具调用，
"连续 N 步无新证据 / 同一工具同参数重复"目前无法确定性计算；v1 只采用"距最后事件的时间"这一可信信号，
"超预估时长"留待任务对象带 `estimate` 后再做。

**前置已补（2026-11-16，Slice AJ）**：`停止` 现在真的杀子进程——control 先 `cancelRunning` 打断
executor 的 `AbortSignal`，再落 `cancelled`；worker 见到 `cancelled` 行只释放锁、返回 `skipped:'cancelled'`。

#### B3 v2 实施记（2026-11-16，release `2026.11.16-7`）

自动暂停与一键恢复落地，默认值由 owner 授权我选定：

- **阈值**：沿用 `DSH_WFXM_TASK_STALL_MINUTES`（默认 15 分钟）。单次 dsh 调用有 10 分钟超时，
  超时一定会落事件，所以「running 且 15 分钟无任何事件」基本等价于真卡死，误杀概率低。
- **开关**：`DSH_WFXM_WATCHDOG_PAUSE`（默认开，`0`/`false` 关）；关闭后回到 v1 的「只提醒」。
- **动作**：先 `worker.cancel(taskId)` 杀子进程，再迁 `paused`（顺序不能反：行先变 paused 而进程还在，
  完成时会撞非法迁移）。通知在入队后才暂停，保证 owner 一定能看到原因。
- **恢复**：`继续 <ref>` → `resumeTask()` 把 `paused → queued`、清租约、`attempt=0`、清 `started_at`
  （不清的话 `claimTask` 的 COALESCE 会沿用旧起点，恢复后立刻再次判定静默），worker 从头重跑。
- **取舍**：恢复是从头执行，不是断点续跑——dsh 单次调用不可中断续跑，这一点在通知里已明说。

生产演练（阈值临时降到 1 分钟，演练后已还原 15）：任务 `tg66pk2dmq` 在启动后 **60s** 自动
`paused`、checkpoint `aborted`、`sleep 3600` 子进程消失；`resumeTask` 后 150ms 内重新 `running`
并拉起新子进程，60s 后再次自动暂停——暂停/恢复循环稳定。

**外部实现参考（prime-agent，2026-11-05）**：其 goal 运行时把"预算耗尽"做成显式终态——
`token_budget / tokens_used / time_used`，续跑上下文分 `continuation / budget-limit / objective-updated`，
耗尽置 `budget_limited` 并写原因，且 pending continuation 不重复生成
（`session_engine/goal_driver.rs`、`goals.rs`）。可借"**显式终态 + 不重复 continuation**"两点；
阈值与是否自动重试仍按本节待定项由 owner 定。

### B4 per-task worktree：B4-b 混合方案（已定 2026-11-03）

**结论**：采纳 **B4-b**——git 业务项目的**代码任务**一任务一 worktree；非 git 与 B 域运维任务保留 workspace 串行；
V2 不废弃，先补三个硬洞，再作为"同一隔离单位内"的兜底。**不采纳全 worktree**：B 域（systemd / docker / 数据库 / 端口）
没有文件隔离收益，反而增加路径、依赖与清理复杂度。

#### B4.1 先钉事实：V2 实际做了什么

| 机制 | 实际行为 | 证据 |
|---|---|---|
| 锁粒度 | 以 **workspace 根**为 key，同 workspace 写串行；读不取锁 | [guard.ts L78-L80](file:///home/ailearn/projects/dsh-wfxm/plugins/governance/src/concurrency/guard.ts#L78-L80) |
| 覆盖工具 | 只有 `write` / `edit` / `str_replace_editor` | [tools.ts L4-L6](file:///home/ailearn/projects/dsh-wfxm/plugins/governance/src/concurrency/tools.ts#L4-L6) |
| 冲突判据 | 同 session 上次读过/写过的指纹 vs 写前指纹；不一致即拒 | [guard.ts L81-L106](file:///home/ailearn/projects/dsh-wfxm/plugins/governance/src/concurrency/guard.ts#L81-L106) |
| 跨进程 | **不支持**，`KeyedMutex` 是进程内队列 | [mutex.ts L2-L4](file:///home/ailearn/projects/dsh-wfxm/plugins/governance/src/concurrency/mutex.ts#L2-L4) |
| 达上限 | 只 `logger.warn`，不暂停、不通知 | [guard.ts L99-L104](file:///home/ailearn/projects/dsh-wfxm/plugins/governance/src/concurrency/guard.ts#L99-L104) |

dsh 的 `withFileLock` 是**跨进程、按单文件、要求 read-render-commit 在同一临界区**的原语（默认等 2 秒），
且目前**没有接到 agent 编辑路径**（[README L57-L63](file:///home/ailearn/githubpro/deepseek-harness/packages/util/atomic-write/README.md#L57-L63)）。

#### B4.2 V2 的缺口（按严重度）

| # | 缺口 | 后果 | 修法 |
|---|---|---|---|
| G1 | **shell 写不受控** | `sed -i`、`git checkout`、`npm install`、`systemctl`、`docker` 全部绕过 | 任务级 workspace 租约覆盖整个任务；worktree 物理隔离 |
| G2 | **未读先写绕过校验** | `prior === undefined` 直接放行，可能覆盖别人刚写的文件 | 目标已存在则拒绝，必须先读；目标不存在才允许创建 |
| G3 | **只进程内互斥** | 多 dsh 进程 / 子进程写同一 workspace 失效 | 需要时叠 `withFileLock`；否则明确"单进程"假设 |
| G4 | **跨文件 / 目录无事务** | 多文件编辑可只成功一半；`mkdir/rm/mv` 不在覆盖范围 | worktree 隔离；多文件变更由 Verifier 判整体 |
| G5 | **冲突只 warn** | 达上限不暂停、不打扰 owner，任务继续乱写 | 转 `paused` + 一条结构化 `attention`（A4） |
| G6 | **路径 identity 未 realpath** | symlink / 不同相对路径进入同一文件，快照键不同 | 快照键用 `realpath`，`ENOENT` 回退到解析路径 |
| G7 | **快照只在内存** | 重启后 `prior` 全丢，退化为零校验 | 重启后强制"先读再写" |

> **定位**：V2 不是"并发正确性"，而是"拦截同一 session 可观测的 stale read-modify-write"。
> 它挡不住 shell 批量写、未读先写、多进程、多文件半成功——这些必须由隔离单位解决。

#### B4.3 三层隔离（B4-b 的骨架）

| 层 | 解决什么 | 不解决什么 | 落点 |
|---|---|---|---|
| **任务级 workspace 租约** | shell 写、跨 turn 读改写、目录操作 | 两个任务仍会排队 | Phase 0，V2 补洞 |
| **worktree（git + A 域）** | 文件系统级物理隔离；所有写路径（含构建/格式化） | 端口、DB、systemd、docker、绝对路径写 | Phase 1 |
| **资源租约** | 端口、数据库、unit、docker 项目名 | 文件冲突 | Phase 2 |

**关键协同**：V2 的锁 key 取自 `workingDirectory.get(session)`。任务进入 worktree 后，锁 key 自动变成 worktree 根，
**guard 代码不用改**就得到"每 worktree 串行"。

#### B4.4 B4-b 八条规则

1. **判定**：任务创建时 `vcs=git`、工作区干净、且属 A 域代码任务 → `isolation=worktree`；否则 `isolation=workspace`。
2. **一任务一 worktree 一分支**；同一 worktree 内仍单写（V2 兜底）；分支名带 `task_ref`。
3. **prepare 只跑一次**（默认 10 分钟上限，失败即任务 `failed`）；用于装依赖、生成 `.env`、初始化子模块。
4. **不复制 ignored / 未提交文件**；需要 `.env` 或本地配置的，由 prepare 或受限 secret 注入，**不得把密钥带进 worktree 快照**。
5. **合并串行**：v1 **不自动合并**；本地 `git merge` 或 PR 由 owner 决定，同一仓库的合并操作取 repo 级锁。
6. **回滚以 `base_commit + branch` 为准**；放弃任务 = 删 worktree / 重置分支，不依赖 restic 全量快照（AR14 补注）。
7. **清理**：worktree 保留期与 receipts/审计对齐；磁盘水位巡检；`git worktree prune`；默认目录 `<repo>/.agents/worktrees/<task_ref>`。
8. **资源声明**：端口 / 数据库 / unit / docker 写进任务计划；没有声明的 B 域任务默认全局串行。

#### B4.5 dsh 提供什么、我们还要自建什么

| 项 | 来源 | 说明 |
|---|---|---|
| 建 worktree / 建分支 / 切 Session 工作目录 | dsh `ctx.worktrees.create`（实验包） | 默认目录 `<repo>/.agents/worktrees/<name>`；从本地 HEAD 建，不 fetch |
| 恢复已删除的 checkout | `worktrees.restore` | 保留分支，可恢复 |
| 沙箱放行 | 宿主策略 | 必须允许写目标目录与共享 `.git` 管理目录 |
| 调度与域判定 | **自建** | 何时开 worktree、哪些任务配 worktree |
| prepare / 依赖安装 | **自建** | 模板化、超时、失败语义 |
| 合并队列与冲突分诊 | **自建** | 串行合并、冲突 → `waiting_input` |
| 清理与磁盘水位 | **自建** | 16 的巡检项 |
| 资源租约 | **自建** | 端口 / DB / unit / docker |

> 约束：worktree 包是**实验特性，默认关闭**；不复制未提交/忽略文件；只支持单主机。
> 这些正好要求我们把"prepare 与清理"当作一等公民，而不是事后补。

#### B4.6 AR8 改写（已生效 v2.1，已替换 [11 §九](11-架构锚定.md) 原条）

> **AR8 v1 原条（已废止）**：**租约与单 workspace 单写任务**（防静默覆盖他人改动，[11 §九](11-架构锚定.md#L1157)）。
>
> **AR8（现行 v2.1）** 并发写隔离：
> 1. 每个**隔离单位**同一时刻至多一个写任务。隔离单位为：git 项目的 **worktree**（一任务一 worktree、一分支）；
>    非 git 工作区为其 **workspace 根**。
> 2. 写工具在隔离单位内串行，并对同一文件做**写前版本校验**；校验失败必须重新读取后再写。
> 3. 跨隔离单位的**代码合并串行**执行；合并冲突必须转 `waiting_input`，不得静默覆盖。
> 4. 非文件资源（端口、数据库、systemd、docker）**不在 worktree 隔离范围内**，必须由计划声明的资源租约串行。
> 5. 隔离单位内仍受 AR11 域闸约束；worktree 根必须在允许写根之内。

#### B4.7 数据模型增量（已生效 v2.1）

| 表 | 增量 | 写者 |
|---|---|---|
| `tasks` | `isolation`（`serial` / `worktree`）、`worktree_path`、`base_commit`、`branch`、`merge_state`（`none` / `pending` / `merged` / `conflict` / `abandoned`） | ⑤ |
| `projects` | `vcs`、`prepare_cmd`、`worktree_root`、`merge_mode`（`manual` / `pr`） | ⑥ |
| `resource_locks` | `resource_key`、`task_id`、`lease_owner`、`lease_expires_at`（Phase 2） | ⑤ |

> **回写与生效状态（2026-11-03）**：结构已写入 [11 §十四](11-架构锚定.md)，数据契约已写入 [15 §十](15-数据与契约.md)；
> **两处均随 v2.1 生效**，AR8 正文与 §三表结构以回写版为准。回写时补了两项 18 未列的字段：
> `tasks.prepare_state` / `prepared_at`（保证 prepare 只跑一次且重启不重跑），以及资源键规范化规则。

#### B4.8 分阶段与门禁

| 阶段 | 内容 | 门禁 |
|---|---|---|
| 0 | 补 G1/G2/G5/G6/G7；V2 仍为唯一机制 | 未读先写被拒；shell 并发被任务租约挡住；重启后不退化 |
| 1 | git + A 域 worktree；prepare；合并串行；清理 | 两任务同文件并行无静默覆盖；合并冲突可见 |
| 2 | `resource_locks`；B 域资源声明；合并队列 | 两任务抢同端口/同 DB 不互相破坏 |

#### B4.9 验收（必须真跑）

| # | 场景 | 判据 |
|---|---|---|
| 1 | 同仓库两任务改同一文件 | 两边都落盘；合并时才冲突；无静默覆盖 |
| 2 | 非 git 两任务写同一文件 | 第二个等待或冲突拒绝 |
| 3 | `bash` 里 `sed -i` 并发 | worktree 互不影响；串行模式被任务租约挡住 |
| 4 | 未读先写已存在文件 | 拒绝并提示先读 |
| 5 | 重启后直接写 | 同样要求先读，不退化为放行 |
| 6 | 两任务 `npm test` 抢同一端口 | 资源锁生效，第二个排队而非报错 |
| 7 | 合并冲突 | 任务 `waiting_input` + 结构化 attention |
| 8 | worktree 清理演练 | 合并/放弃后目录删除，磁盘回基线，`prune` 后无悬挂 |

#### B4.10 代价、风险与待定

- **磁盘与时间**：每 worktree 一份 checkout + 依赖安装；pnpm 硬链接降磁盘但不降安装时间，靠 prepare 缓存与并发上限控制。
- **环境文件缺失**：`.env`、ignored 配置不复制，任务会以明确错误码失败，而不是静默改错文件。
- **合并负担转移**：冲突从"写时覆盖"变成"合并时可见"，可回滚，但需要 owner 处理；v1 不自动合并。
- **实验特性**：`experimental/worktree` 随 dsh 升级可能变；12 的兼容矩阵要覆盖它。
- **路径与权限**：worktree 根必须落在 AR11 允许写根内；沙箱必须放行 `.git` 管理目录。
- **待定**：非 git 工作区占比（决定全局锁是否长期保留）；`prepare` 模板粒度；`merge_mode` 默认 manual 还是 PR；
  worktree 保留期与 receipts/审计的对齐值。

---

## 五、C 类：明确不吸收

| # | 不吸收 | 理由 |
|---|---|---|
| C1 | 公共群聊无人 @ 主动外发 | 与"只在被请求或书面规则允许时行动"冲突；最多 observe 记录，不外发 |
| C2 | BYOM（云端计算 + 本地 daemon） | S1/S2 是单机自托管；引入云端多一个信任边界，收益不在 v1 |
| C3 | 多租户 / 团队协作 | X2 单用户；团队提示与权限模型会显著放大对象模型 |
| C4 | 跨来源身份推断 | 只做**显式配对**（owner 自己绑），不推断"飞书某人 = GitHub 某人" |
| C5 | A2A 自由协商 | 已定专家只作受限执行器接入（AR34）；A2A 只作接入协议 |
| C6 | v1 投机执行 | 只允许 R0 只读预取并显式标注才可考虑；R2+ 禁止，v1 不做 |
| C7 | "数据永不删除" | 原型自认的已知问题；我们有热/温/冷保留分层 |
| C8 | 照抄"Router 无 Bash" | 原型 Router 实际仍带 `bash/read`，靠提示规则不读代码；我们 `dispatcher` 已只 `task_*`，无需再加限制 |

---

## 六、冲突与措辞复核

| # | 冲突点 | 现状 | 建议 | 是否改 AR |
|---|---|---|---|---|
| X1 | 身份映射 | [11 §5.8 G3](11-架构锚定.md#L1024) 把多渠道身份映射到同一 `actor_id`；原型明确"不同 Source 身份永不互映射" | 保留**显式配对**，禁止**推断同一人**；审计仍记录"哪个渠道、哪个源内身份"（AR10） | 只补措辞，不改 AR10 |
| X2 | 审批超时 | 我们超时 → `paused`；原型"只有人能 stop，执行器不得声称人要求停止" | 补一句：模型不得代填"人已同意/人要求停止"，只有网关来的 actor 应答才算 | 补注 AR10 |
| X3 | 任务↔会话 1:1 | 11 §5.1 硬约束 4 | 若采纳 B1，需改为"任务 ↔ 执行会话 1:1；任务 ↔ 线程多对多" | 是（B1） |
| X4 | AR8 单 workspace | 全局串行 | **B4-b 已定并生效**：改为"隔离单位单写；git 一任务一 worktree；非 git 保持 workspace 串行；资源另锁"，见 §四 B4.6 与 [11 §十四](11-架构锚定.md) | 是（B4） |
| X5 | 回执一次 | 11 §5.1"回执一次写入，重复完成不覆盖" | 若采纳 B1，改为"每次 Assignment 一次回执；任务终态另有一条最终回执" | 是（B1） |
| X6 | "安全边界" | AR11 读起来像强边界 | A11 补注 + 16 兜底 + 绝对路径绕过用例 | 补注，不改 AR11 |

---

## 七、对两个核心痛点的影响

| 子问题 | 现状手段 | 吸收项 | 预期变化 | 度量指标 |
|---|---|---|---|---|
| 上下文腐化 | 13 分层装配 + 硬配额 | A13 | 结论可追、压缩后可回读 | 回读成功率；压缩后证据丢失率 |
| 跨任务串味 | 任务↔会话 1:1 | B1 | 追问有确定归属，不再靠"猜" | **误挂率**（挂到错误任务的比例） |
| 任务卡死 | 租约回收 | B3 | "活着但无进展"能被发现 | stall 检出率；误报率 |
| 静默错 | Verifier + 快照 | 不变 | 不因对照而削弱 | 判据通过但用户拒绝的比例 |
| 外部动作重复 | 幂等键 | A6 | 重启后先核对再重做 | 重启后重复外部动作次数 |
| 并行冲突 | V2 全局串行 | B4 | git 项目并行不打架 | 冲突计数；任务 p50/p95 |
| 打扰过多 | G6 打扰分级 | A1/A12/B1 | 不重复评估、不重复确认 | 每 100 条入站的发送数；人工介入次数 |
| 不可解释 | 审计 | A7/A9 | "为什么没理我/为什么变了"可查 | 被过滤消息可解释率；提示 diff 可见率 |

> **不要用原型的实验数字证明执行质量**。它的实验是**合成负载 + 简化环境 + 1/4 时间缩放**，
> 只测调度与协作，且注明"不衡量单个任务的实际执行能力"。p50 12.4 / p95 15.7 分钟 vs 单会话 p95 29.5 分钟，
> 只能说明"双层 + 事件直通"在调度层面有效，不能说明我们采纳后任务成功率会同比提升。

---

## 八、待 owner 决策清单

> 这些不是技术选型，是产品/结构决策；按 [AGENTS §5](../AGENTS.md) 不替 owner 决定。

| 编号 | 决策点 | 选项 | 建议 | 阻塞级别 |
|---|---|---|---|---|
| D18-1 | Thread/Subscription 是否进 v1 | 全量 / **最小切片** / 不做 | 最小切片（先飞书话题/单聊，单活工单） | 高 |
| D18-2 | 主动路径范围 | 不做 / **机器事件 observe** / +owner 会话 observe / auto 白名单 | 机器事件 observe，不接公共群聊 | 中 |
| D18-3 | Watchdog 级别 | 不做 / **确定性 only** / +模型判偏航 | 确定性 only | 中 |
| D18-4 | 并发写策略 | 现状全局串行 / **混合 worktree** / 全 worktree | ✅ **已定 B4-b（2026-11-03）**：git + A 域一任务一 worktree，非 git / B 域 workspace 串行；V2 先补洞 | 高 |
| D18-5 | 身份映射措辞 | 维持现状 / **显式配对 + 禁止推断** | 后者，补审计措辞 | 低 |
| D18-6 | 11 的版本处理 | **先只吸收 A，B 另起 v2** / A+B1 同批 / 全部同批 | ✅ **已定并生效（2026-11-03）**：A 类吸收；B1/B4/C 前台并入 v2.1 | 高 |
| D18-7 | 前台架构 | 维持 dispatcher / Router 只换自动入口 / **Router 唯一前台（窄 preset）** / Router 兼治理 | ✅ **已定 C（2026-11-03）**：Router 唯一前台，执行/审批/配置留后台 | 高 |

---

## 九、建议实施顺序与验收

**顺序原则**：先补语义、再动运行时、最后动结构；每件独立可中止，每步都要真实跑通。

| 阶段 | 内容 | 验收（必须真跑） |
|---|---|---|
| 0 | 写 A3/A4/A7 的回放用例（不写代码） | 用历史消息回放，能复现"说不清/等不明/没理我" |
| 1 | A3 / A4 / A7 / A1 | 六类阶段显示正确；无 attention 的"等人"被拒；过滤可解释；三档准入行为正确 |
| 2 | A5 / A6 / A8 / A11 / A12 | 并发占满时人话仍被处理；重启不重复外部动作；同会话消息有序；3 条连发一次分诊 |
| 3 | A2 / A9 / A10 / A13 | 规则变更通知活任务；提示 diff 可见；首屏答三问；结论可回读 |
| 4 | D18-1 最小切片 → D18-4 | 同线程追问不新建任务；结束任务可被唤醒；git 项目并行无物理冲突 |
| 5 | D18-2 → D18-3 | observe 记录可审；stall 检出且误报可接受 |
| 6 | D18-7 C 方案（前台） | 有确认；追问不新建；attach 仅显式；审批旁路；orchestrator 不可执行 |

**纪律**（沿用 AGENTS §6）：不接受只在单测里过；跨切改动同批更新依赖它的测试；
声称完成前必须有 fresh 验证输出。每个阶段至少包含一次**重启演练**与一次**渠道失败注入**。

---

## 十、开放问题（供下一轮分析）

1. 飞书"话题/单聊"与 Web 会话，哪些算 Thread？三者是否同一套订阅语义？
2. 一个会话里同时有多件工作时，人如何知道"这句话在跟哪个任务说"？需要可见的卡片/标签吗？
3. 订阅消息绕过 Gate 后，内容注入如何兜底？"数据不是指令"靠提示够不够，还是需要 S1 注入扫描？
4. observe 的记录本身会不会变成新噪音？用日报还是面板摘要？
5. Watchdog 的"无进展"阈值怎么定？大编译/大下载如何避免误杀？
6. B4 落地后，非 git 工作区（配置文件、数据库、容器）占多少？是否值得为它保留全局锁？
7. resume 复用同一 Grant，与我们"审批按 plan 绑定"是否冲突？plan 变化时是否需要重新审批？
8. per-task worktree 的磁盘与清理：与快照保留期、冷热分层如何对齐？
9. 引入 Thread 后，幂等键以 Trigger 为单位还是以"消息 + 线程"为单位？与 `inbox` 的唯一键如何统一？
10. 面板三问落到 Web/IM/CLI 三端时，哪些只能在 Web（AR26 管理面）？IM 端最小视图是什么？

---

## 十一、前台架构：Router 作为唯一前台（C 方案，已定 2026-11-03）

> **状态**：owner 已选定 **C**（2026-11-03），**并已回写 v2 生效**。
> 11 / 15 / 17 / 13 / 14 / 08 正文已按本节统一修订；B1/B4 已于 v2.1 生效，C 方案只改变"谁对 owner 说话"。

### 11.1 为什么 Router 更适配个人助手

| 产品诉求 | 原 dispatcher（只建任务） | Router 前台 |
|---|---|---|
| 连续对话 | 每条请求容易变成任务卡片；人话分散在 ①/⑤/Outbox | 一个前台负责接单确认、追问、结果交付 |
| 多场景任务 | 自动触发只能建任务或丢弃 | 先判断 accept / attach / ignore / stop，再派给任务或专家 |
| "接着说刚才那件事" | 靠 B1 锚点；无锚点时反问或分诊 | attach 语义可覆盖显式引用与追问 |
| 主动性 | G 域只有定时巡检 | 候选卡片 + 评估 + ignore，降低噪声 |
| 个人助手感 | 像"任务受理机" | 像"同一个同事在跟我办事" |

> **结论**：产品层选 Router 是对的；但**Router 只做前台，不做治理**。执行、审批、配置、审计留在内核。

### 11.2 形态：一个前台 + 四个后台

```
owner ──▶ ① 网关（准入 / 去重 / 审批旁路 / 结构化命令旁路）
             │
             ▼
        orchestrator（唯一前台 · 窄工具面）
        ├─ 直接回答（只读）
        ├─ 确认 / 追问 / 交付（写 outbox，经 ①）
        ├─ task_submit ──▶ ⑤ 任务运行时（唯一任务写者）
        ├─ 显式 attach（仅锚点命中）
        ├─ 显式 stop（结构化优先）
        └─ ignore（记 disposition + 原因）
             │
             ▼
        ② 判级 / ③ 审批 / ④ 审计 / ⑥⑦ 能力域
```

**orchestrator 是 agent，但不是执行者。** 它的判断只体现在"接不接、挂哪件、要不要问、停不停"，
不体现在"怎么做、做到什么程度"。

### 11.3 工具面白名单与三条硬规则

| 允许 | 禁止 |
|---|---|
| 读 `task_submit` / `task_status` / `task_control`（取消） | `exec_*`、`fs_write`、`svc_*` |
| `thread_lookup`（B1 只读视图） | 审批、Grant、配置、插件管理 |
| `disposition_record`（accept / attach / ignore + 原因） | 任意 shell、任意外发 |
| `say`（文本 / 卡片，只能复用回执与证据） | 语义相似推断 attach |
| `memory_search`、受限 `fs_read` | 读日志后自行下技术结论 |

**三条不让步的硬规则**

1. **审批不进模型**：审批应答、结构化停止/状态命令、未配对身份、重复消息，全部在 ① 旁路。
2. **attach 只认显式引用**：消息、PR、Issue、`task_ref`；禁止"主题相似"推断（B1 的 AR36 继续有效）。
3. **stop 要确认**：结构化命令直接执行；自然语言"先别弄了"在多个活任务时要反问，不能由模型直接取消。

### 11.4 必须同步的三个结构改动

| # | 改动 | 原因 | 落点 |
|---|---|---|---|
| 1 | **`outbox` 归 ①** | 11 说 ① 负责"出站与回执"，15 却把 `outbox` 写者定为 ⑤；Router 当前台后矛盾会暴露 | 15 §三 / §六 |
| 2 | **一个 owner 一个 orchestrator 会话 + Thread 作用域装配** | 避免"飞书私聊一个助手、话题群另一个助手"；上下文隔离靠 Thread 与装配预算，不靠多开会话 | 13、15 `session_routes` |
| 3 | **新增窄 preset `orchestrator`；`chat` 降为 Web 深度会话** | 现有 `chat` 有 `fs_write` / `exec_run` / `svc_*` / `mail_send`，直接当前台会把执行权限带进前台 | 17 §二 |

> 任务仍是一任务一会话（AR8/B4 不变）；orchestrator 只负责"哪件事、谁来做、怎么回人话"。

### 11.5 AR25 修订（已随 11 v2 生效）

> **AR25 v1（已被 C 方案改写）**：**触发单一入口**：所有自动触发经唯一 `dispatcher` 会话，它只建任务不执行业务。
>
> **AR25（现行 v2）唯一前台与唯一调度入口**：
> 1. 面向 owner 的对话与自动触发都只经唯一 `orchestrator` 角色；它可回答、确认、追问、建任务、
>    显式挂接、显式停止、记忽略。
> 2. orchestrator **不执行业务、不审批、不改配置、不管理插件**；工具面白名单，启动自检校验。
> 3. 审批应答、结构化命令、未配对身份、重复消息必须旁路，不进模型。
> 4. 任务创建仍只经 ⑤ 的 `task_submit`；入口不得直写 `tasks`。
> 5. 挂接只在显式引用时允许；禁止语义推断。

### 11.6 数据与审计增量

| 对象 | 增量 | 写者 |
|---|---|---|
| `route_decisions` | `id`、`trigger_id`、`action`（`answer/ack/ask/accept/attach/ignore/stop`）、`target_task_id`、`thread_id`、`reason`、`confidence`、`prompt_version`、`created_at` | ① |
| `outbox` | 写者由 ⑤ 改为 ①；⑤ 只写 `receipts` 并发出事件 | ① |
| `session_routes` | 增加 `orchestrator` 会话类型标记；仍按 `(channel_id, chat_id)` 粘性 | ① |

- 不新增端口；`say` / `task_*` / `thread_lookup` 都是模块 API 或既有工具。
- 任务创建幂等仍由 `inbox(channel_id, msg_id)` 与 `trigger_id` 保证（AR28）。
- `route_decisions` 只追加，用于回答"为什么没理我 / 为什么挂到那件事"。

### 11.7 与既有不变量的关系

| 不变量 | 影响 |
|---|---|
| **AR10 / AR26** | 不变：审批仍是一等对象，管理面仍仅 Web；orchestrator 不能审批 |
| **AR23 / AR33** | 任务仍只有 ⑤ 写；`route_decisions` 只有 ① 写；跨模块只经 API |
| **AR30 / AR31** | orchestrator 的工具面是权限上限；执行工具不在其 preset，闸不可绕 |
| **AR35** | 不变：订阅/唤醒不授权，只投递；orchestrator 不能凭消息内容提权 |
| **AR36** | 不变：线程单主 + 显式锚点；attach 不得用语义推断 |
| **AR8 / B4** | 不变：任务隔离单位与单写规则不受前台改造影响 |

### 11.8 分阶段与验收

| 阶段 | 内容 | 验收（必须真跑） |
|---|---|---|
| A | orchestrator 前台 + 窄 preset；确认 / 追问 / attach / ignore；审批旁路 | 一句话下单有确认；追问不新建任务；审批不进模型 |
| B | 自然语言 stop（多活先确认）；主动候选 ignore | "先别弄了"在双活任务时反问；ignore 有原因可查 |
| C | 专家路由与候选卡片 | 多领域任务分派正确；卡片一次决定多条 |

**验收（必须真跑）**

| # | 场景 | 判据 |
|---|---|---|
| 1 | "帮我看下磁盘" | 先确认再建任务；结果回到同一 Thread |
| 2 | "刚才那个任务呢" | attach 到既有任务，不新建 |
| 3 | 两个活任务时说"停掉" | 反问"哪一件"，不直接取消 |
| 4 | 审批卡片点击 | ① → ③，orchestrator 不参与 |
| 5 | orchestrator 不可用 | 显式请求仍可建任务；不静默丢消息 |
| 6 | 邮件正文含指令 | 不触发建任务；只有 owner 消息可路由 |
| 7 | 模型改写结果 | `say` 保留 evidence locator，不新增技术结论 |
| 8 | 审计回放 | 每条消息可回答"回答/建任务/挂接/忽略/停止"及原因 |

### 11.9 风险与缓解

| 风险 | 缓解 |
|---|---|
| 提示注入 | 源内容标不可信；结构化字段优先；工具白名单；动作 schema + 幂等 |
| 交付改写漂移 | `say` 只能复用回执与证据，新增结论即失败 |
| 延迟与成本 | S1 快路径 + 小模型路由 + 批量候选卡片 |
| 单会话上下文膨胀 | Thread 作用域装配 + 预算 + compaction；任务独立会话 |
| 权限蔓延 | preset 启动自检；新增工具必须过三件套与 AR31 |
| 两个助手 | 人话出口唯一：orchestrator → outbox(①)；⑤ 不再直接发人话 |

### 11.10 决策与合入清单

**D18-7 已定 C（2026-11-03）**：

| 选项 | 含义 | 结论 |
|---|---|---|
| A | 维持 dispatcher 只建任务 | 最稳，但不适配个人助手体验 |
| B | Router 只替换自动触发入口 | 折中，日常对话仍是旧体验 |
| **C** | **Router 作为唯一前台（窄 preset + 五条旁路）** | ✅ 已定 |
| D | Router 兼做治理/审批 | 不做，混淆前台与闸 |

| 文档 | 改动 | 状态 |
|---|---|---|
| 08 | 产品侧加：连续前台、接单确认、追问/挂接、忽略理由（落在 A1/A2/A3/A6，不增编号） | ✅ 已回写 §A |
| 11 | AR25 v2 改写；§5.3 入站加旁路；§5.8 G2；§十三直达例外 | ✅ 已回写 v2 |
| 13 | 一个 orchestrator + Thread 作用域装配 | ✅ 已回写 §2.1/§2.2 |
| 15 | `outbox` 写者改 ①；新增 `route_decisions`；`session_routes` 加 `session_kind` | ✅ 已回写 §三/§四/§九 |
| 17 | 新增 `orchestrator` preset；`chat` 降为 Web 深度会话；验收 10 条 | ✅ 已回写 §二/§三/§四/§十 |
| 14 | 飞书确认/追问/结果同 Thread；审批卡片仍由 ③ | ✅ 已回写 §三/§九/§十一 |

---

## 附录 A：原型机制索引

| 机制 | 位置 |
|---|---|
| 领域对象 Trigger/Thread/Ticket/Assignment/Subscription；拒绝概念清单 | [001-domain.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/001-domain.md#L21-L60) |
| 两条路径、强度、准入表、accept mode、策略版本、复验、Eval 未完成 | [002-authorization.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/002-authorization.md#L7-L155) |
| 阶段表、worker slot、prepare、执行变量、失败/重启、Effects、渠道失败 | [003-execution.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/003-execution.md#L5-L203) |
| 提示装配顺序、覆盖与版本、Default updated、执行器无提问工具 | [004-prompts.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/004-prompts.md#L19-L96) |
| 面板三问、Tab、精确标签、七条原则 | [005-panel.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/005-panel.md#L5-L58) |
| 运行类、Engine/Policy/Store/Effects/Sources、持久化表、模型面、配置热更新、开放问题 | [007-architecture.md](file:///home/ailearn/githubpro/dsh-superagent-prototype/docs/007-architecture.md#L1-L617) |
| **文章-only、原型未实现**：Watchdog、Inline & Spill、Chain of Recall、投机执行、计算/状态/环境分离 | 文章；`grep watchdog/inline spill/speculat` 在原型 `docs/ src/ prompts/` 零命中 |

---

## 附录 B：文章要点（避免转述失真）

- **四项特征**：连续（跨 IM/GitHub 同一任务）、高效（并行多任务）、主动（观察环境自行推进）、持久（长期在线可恢复）。
- **五个组成**：双层架构、事件驱动、面向人的交互、计算/状态/环境分离、Watchdog。
- **两个上下文机制**：Inline & Spill（近期信息进窗口，超出预算/低频内容留在窗口外按需读取）；
  Chain of Recall（沿 Trigger/Thread/Worker Session 的引用关系逐步找回历史）。
- **异步 ReAct Loop**：耗时工具改为 `start()` / `stop()`，启动后台任务即返回 Started，结果作为新事件进入会话；
  文章称 dsh 已实现但**未默认开启**。
- **实验**：约 300 条消息/轮、约 20 条工作请求、每种方案 5 次；Super-agent p50 12.4 / p95 15.7 分钟，
  中性提示单会话 p95 29.5 分钟；Router 压力测试 1→40 条/分钟时批大小 1.0→2.8、单次请求 2.5→3.9 秒、
  单决定分摊推理 6.4→1.6 秒。**局限**：合成负载、简化环境、1/4 缩放、不衡量单任务执行质量。
- **文章自述开放问题**：Router 随任务规模扩展、跨月长程记忆、脱离 Session 的人机协作、A2A、安全与隐私
  （云端接本地设备后的提示注入、端侧凭据、跨设备权限）。

---

## 附录 C：B1 最小切片详细设计（第二轮分析）

> 本节把 B1 从"方向"细化为"可实施切片"。**B1 已于 2026-11-03 经 owner 确认生效 v2.1**，字段名与不变量已回写 11/15。
> **回写状态（2026-11-03）**：结构已写入 [11 §十三](11-架构锚定.md)，数据契约已写入 [15 §九](15-数据与契约.md)；
> **两处均随 v2.1 生效**。C.3 的视图字段有一处收敛，见 15 §9.4 修订说明。

### C.1 五条结论

1. **Thread ≠ 聊天**：Thread 是"能唯一确定这段话在说哪件事"的**回复锚点**（话题，或根消息）。
2. **v1 只做飞书**：话题群用 `thread_id`；单聊/普通群用"根消息 + reply-to"；Web 与 GitHub 订阅后置。
3. **一个聊天可有多张任务，但一个 Thread 只有一个默认归属任务**；显式锚点可以绕过默认归属。
4. **直达不等于授权**：订阅消息绕过 `dispatcher`，但不绕过准入、Grant、工具闸、审批。
5. **唤醒是新的一轮**：同一任务、同一执行会话、`round + 1`、回执按轮次；`failed` 与人工 `cancelled` 不可唤醒。

### C.2 Thread 的等价物

| 场景 | Thread 键 | 自动归属 | 说明 |
|---|---|---|---|
| 飞书单聊 | `chat_id + root_msg_id`（任务发起消息） | 有锚点，或"聊天内仅一个活任务"时 | 单聊没有 topic，根消息充当锚点 |
| 飞书话题群 | `chat_id + thread_id` | 是 | 回复天然落话题 |
| 飞书普通群 | `chat_id + root_msg_id` | **否**，需显式 reply-to | 整群消息不能自动吞进任务 |
| 飞书审批卡片 | 不建 Thread | — | 卡片应答走审批旁路（11 §5.3） |
| Web 会话 | 不做（v1） | — | 管理面保持现状 |
| GitHub Issue/PR | 不做（v1.1） | — | 后置 |

**硬规则**：

- Thread 的键必须**窄到只覆盖这件事**：话题群用 topic；单聊/普通群用"发起消息"作根，后续必须 reply-to 根或任务产出的消息。
- **没有 reply-to 且聊天内存在多个活任务** → 发一张"哪一件"卡片（最多 3 个候选 + "新任务"），
  60 秒无应答交 `dispatcher`；**绝不默认挂最近任务**。
- 不允许用"主题相似"推断归属（原型明确拒绝）。

### C.3 数据模型（最小改动）

**新增表（3 张）**

```sql
-- ① 渠道网关（正本）
CREATE TABLE threads (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('topic','root')),
  topic_id     TEXT,                      -- 飞书 topic
  root_msg_id  TEXT,                      -- 单聊/普通群的根消息
  project_id   TEXT,
  created_at   TEXT NOT NULL,
  last_msg_at  TEXT
);
CREATE UNIQUE INDEX ux_thread_key
  ON threads(channel_id, chat_id, kind, COALESCE(topic_id,''), COALESCE(root_msg_id,''));

-- ⑤ 任务（正本）
CREATE TABLE task_threads (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  relation      TEXT NOT NULL CHECK (relation IN ('default_owner','anchor')),
  anchor_msg_id TEXT,                     -- anchor 时：发起/结果/提问消息
  created_at    TEXT NOT NULL,
  released_at   TEXT,
  release_reason TEXT CHECK (release_reason IN ('handback','stopped','superseded','failed'))
);
CREATE UNIQUE INDEX ux_task_thread_live
  ON task_threads(task_id, thread_id, relation, COALESCE(anchor_msg_id,''))
  WHERE released_at IS NULL;
CREATE UNIQUE INDEX ux_thread_default_owner
  ON task_threads(thread_id) WHERE relation='default_owner' AND released_at IS NULL;

CREATE TABLE task_inputs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  inbox_id     TEXT NOT NULL,
  round        INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','delivered','read','returned')),
  delivered_at TEXT,
  read_at      TEXT,
  error_code   TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_task_input_dedup ON task_inputs(task_id, inbox_id);
```

**字段扩展（4 处）**

| 表 | 新增字段 | 用途 |
|---|---|---|
| `inbox` | `chat_id`、`thread_id`（可空）、`reply_to_msg_id` | 锚点解析；去重键不变 |
| `tasks` | `round INTEGER NOT NULL DEFAULT 1`、`origin_msg_id`、`task_ref TEXT UNIQUE` | 轮次；发起锚点；不可猜测的短码（卡片/链接锚点） |
| `receipts` | `round`、`external_msg_id` | 每轮一次回执；结果消息作为新锚点 |
| `outbox` | `task_id`、`thread_id`、`reply_to_msg_id` | 回到原线程/原消息，不新开会话 |

**命名冲突（必须改）**：[15 `session_routes`](15-数据与契约.md#L97-L105) 现在把 `thread_id` 当"飞书 chat_id"用。
引入 Thread 后语义冲突，建议改为 `(channel_id, chat_id, session_id)`；话题/根消息不进 `session_routes`。

**单一写者**：`threads`/`inbox`/`outbox` 归 ①；`task_threads`/`task_inputs`/`tasks`/`receipts` 归 ⑤（`outbox` 按 C 方案已改归 ①）；
① 通过 ⑤ 的只读视图 `v_task_anchors`（`task_id, channel_id, chat_id, anchor_msg_id, kind`）解析归属，禁止直读表（AR33）。

**AR2 提醒**：`task_inputs` 只存 `inbox_id` 与状态，**不复制消息正文**；正文进会话，不落业务库。

### C.4 入站路由决策表（first-match-wins）

> `live` = `queued / running / waiting_input / waiting_approval`；`可唤醒` = `succeeded` + 未释放订阅 + Grant 复验通过。

| 顺序 | 条件 | 动作 | 过 dispatcher |
|---|---|---|---|
| 1 | 命中未决审批的应答 | 审批旁路 | 否 |
| 2 | actor 未配对 / 未准入 | 准入失败，静默拒绝并审计 | 否 |
| 3 | 结构化停止命令（面板/卡片） | 停止任务，释放全部 relation | 否 |
| 4 | bot/CI 消息 + 锚定 Thread 有 live 默认归属 | 作为上下文 input 投递，不唤醒 | 否 |
| 5 | bot/CI 消息 + 无 live 默认归属 | 只记录，不唤醒 | 否 |
| 6 | 已配对 owner + reply-to/`task_ref` 命中锚点 + 该任务 live | 投递该任务 | 否 |
| 7 | 已配对 owner + 锚点命中 + 该任务可唤醒 | 复验（AR37）→ 唤醒，`round+1` | 否 |
| 8 | 已配对 owner + 锚点命中 + 任务 `failed/cancelled` | 分诊（新建或显式重试） | 是 |
| 9 | 已配对 owner + 无锚点 + 聊天内**恰好一个** live 任务 | 投递该任务 | 否 |
| 10 | 已配对 owner + 无锚点 + 聊天内**多个** live 任务 | 发"哪一件"卡片；60 秒无应答交分诊 | 超时后是 |
| 11 | 其余（无 live、普通群无 reply-to、paused 任务） | 分诊 | 是 |

> **无锚点不唤醒**：已结束任务只能靠 reply-to / `task_ref` 唤醒，不靠"聊天里只剩它"猜测。
> 这是刻意保守：少一次自动续接，换零误唤醒；v1.1 再评估"续接意图"。

**锚点集合**：任务发起消息（`tasks.origin_msg_id`）、每轮结果消息（`receipts.external_msg_id`）、
结构化提问消息（`task_attention.external_msg_id`）、任务短码 `tasks.task_ref`（由结果卡片/链接携带）。
四者任一命中，都指向该任务；`task_ref` 只作路由提示，不授予权限。

### C.5 生命周期

```text
创建任务（来自 Thread T）
  → task_threads: default_owner=T, anchor=origin_msg_id
投递（T 上的人话，任务 live）
  → task_inputs pending → 下一 turn 前 delivered → 任务读入
结束（succeeded）
  → 保留 default_owner + anchors（不删）
唤醒（T 上锚定人话）
  → 复验 Grant/策略/actor → round+1 → 复用同一执行会话 → 新回执
交回（超出范围）
  → 释放 default_owner（reason=handback）→ dispatcher；老任务保留 anchors
新建任务（同 T）
  → 新任务成为 default_owner；老任务降为 anchor
停止（人）
  → 释放全部 relation（reason=stopped）→ 此后 T 无默认归属
失败（failed）
  → 释放 default_owner（reason=failed）→ 不可唤醒
```

| 规则 | 说明 |
|---|---|
| **归属变更只有四种触发** | 新建 / 交回 / 停止 / 失败；全部写审计 |
| **交回只允许一次** | worker 不得自行丢弃或连续交回；带 reason |
| **paused 不投递** | "人的暂停要按住"；暂停期间消息走分诊，不自动唤醒 |
| **不新建会话** | 唤醒复用同一执行会话；Thread 不是会话 |

### C.6 轮次、回执、幂等

- `tasks.round` 从 1 起；每次唤醒 +1；同一执行会话，不新建 session。
- 回执唯一键 `(task_id, round)`；把 [11 §5.1](11-架构锚定.md#L848) 的"回执一次"修订为"**每轮一次**"。
- 最终态单独落 `tasks.status`；回执只是该轮的对外报告，不是终态。
- 入站去重仍是 `(channel_id, msg_id)`；投递去重是 `(task_id, inbox_id)`；两层都幂等。
- 重启：`task_inputs.status='pending'` 重放；`delivered/read` 不重放；重复消息不产生第二个用户 turn。
- 同 Thread 出站按 `order_key=thread_id` FIFO（A8）；不阻塞其他 Thread。

### C.7 权限与安全

- 订阅消息**不产生 Grant、不提高风险等级、不绕过 `tools/pre-execute`、不绕过审批**（拟 AR35）。
- **只对已配对 owner 自动投递**；其他 actor（含群成员）走准入/分诊。
  这一条与原型"regardless of who sent it"不同——我们更严，理由是单 owner 模型下不能把陌生人的话当授权。
- 订阅消息是**数据不是指令**；正文进会话前过 S1 注入扫描。
- 唤醒前**复验** Grant（scope/expiry/revoked/actor/policy_version）；失败按"无主消息"分诊（拟 AR37）。
- v1 停止只允许 **Web 面板 + 全局 kill switch**；签名卡片按钮放 v1.1；自由文本"停"不识别为 stop，交分诊。

### C.8 与现有文档的改动清单

| 位置 | 现状 | 改动 | 级别 |
|---|---|---|---|
| [11 §5.1 硬约束 4](11-架构锚定.md#L851-L856) | 任务↔会话 1:1 | 任务↔执行会话 1:1；任务↔Thread 1:N | 改 AR |
| [11 §5.1 回执](11-架构锚定.md#L848) | 每任务一次 | 每轮一次 | 改语义 |
| [11 AR25](11-架构锚定.md#L1174) | 触发单一入口，都经 dispatcher | 增例外：订阅直达既有任务，不经 dispatcher，不建任务 | 补注 |
| [11 §四 对象模型](11-架构锚定.md#L748-L813) | 四对象 | 增 Thread / Subscription（Task 附属） | 改对象模型 |
| [15 `session_routes`](15-数据与契约.md#L97-L105) | `thread_id` = chat_id | 改 `chat_id`；话题另表 | 迁移 |
| [15 `inbox`](15-数据与契约.md#L51-L66) | 无 chat/thread/reply_to | 增 3 字段 | 无 |
| [15 `tasks/receipts/outbox`](15-数据与契约.md#L222-L294) | 无 round/task/thread/reply | 增字段 | 无 |
| [14 飞书](14-飞书接入方案.md) | 已有话题/回复 | 明确 `topic_id` 与 `reply_to_msg_id` | 补细节 |
| [17 worker](17-Agent侧设计.md) | 无追问归属 | 增"范围内处理、超范围交回一次" | 补提示 |
| A12 合并窗口 | 同会话合并 | 改为"同 Thread 串行 + 合并" | 细化 |

### C.9 新增不变量（已生效 v2.1，已并入 [11 §九](11-架构锚定.md)）

- **AR35（订阅不授权）**：Thread 订阅只提供上下文；不产生/扩大 Grant，不改变风险等级，不绕过工具闸与审批。
- **AR36（线程单主 + 显式锚点）**：一个 Thread 至多一个 `default_owner`；显式锚点可指向其他任务；
  归属变更只由新建/交回/停止/失败触发，必须留审计。
- **AR37（唤醒复验）**：唤醒已结束任务前必须复验 Grant（actor/scope/expiry/revoked/policy_version）；
  失败按无主消息分诊。

### C.10 明确不做（v1 边界）

1. 不做 Web/GitHub 订阅。
2. 不做普通群"整群自动归属"。
3. 不做无锚点的多活任务仲裁（交分诊/反问）。
4. 不做 context-only 订阅（其他任务的上下文注入）。
5. 不做跨渠道 Thread 合并。
6. 不做 `failed/paused` 任务的自动唤醒。
7. 不让模型从自由文本推断"这句话属于哪个任务"或"是否停止"。

### C.11 验收场景（必须真跑）

| # | 场景 | 期望 | 证据 |
|---|---|---|---|
| 1 | 话题群，任务 live，追问 | 同任务、同轮次投递，不过 dispatcher | `task_inputs` delivered；无新任务 |
| 2 | 话题群，任务 ended，追问 | `round+1`、复用同会话、新回执、无新任务 | `tasks.round`；`receipts(task_id,round)` |
| 3 | 单聊仅一个活任务，无 reply-to | 投递该任务 | `task_inputs` |
| 4 | 单聊两个活任务，无 reply-to | 反问卡片；60 秒无应答交 dispatcher | 决策记录 + 卡片消息 |
| 5 | 单聊两个活任务，reply 到 A 的结果 | 只投 A | `task_inputs(task_id=A)` |
| 6 | reply 到结构化提问消息 | 作为答案投递，`waiting_input → running` | `task_attention` 应答 |
| 7 | 普通群无 reply-to | 交 dispatcher，不自动归属 | 决策记录 |
| 8 | 非 owner 在话题里说话 | 准入/分诊，不投递 | 拒绝审计 |
| 9 | bot/CI + 任务 ended | 只记录，不唤醒 | disposition |
| 10 | Grant 已撤销/过期 | 不唤醒，按无主消息分诊 | `decisions` |
| 11 | 面板 stop 后有人追问 | 不唤醒；释放归属；走分诊 | `released_at` |
| 12 | 任务 failed 后追问 | 新任务，不唤醒 | 新 `task_id` |
| 13 | 超范围追问 | 交回一次 → dispatcher；老任务转 anchor；新任务 default owner | `release_reason=handback` |
| 14 | 重启发生在 inbox 落库与投递之间 | 只投递一次 | `task_inputs` 唯一键 |
| 15 | 同一 `msg_id` 重放 | 只投递一次 | `inbox` 去重 |
| 16 | 两条无锚消息并发 | 同 Thread 串行；仅一个 default owner | 串行锁 + 唯一索引 |
| 17 | 结果卡片带 `task_ref`，用户点"继续" | 直达该任务，无需 reply-to | 卡片 action + `task_ref` |
| 18 | 伪造 / 已失效的 `task_ref` | 拒绝，按无主消息分诊 | 查库失败审计 |

### C.12 度量（上线前后对比）

| 指标 | 定义 | 目标 |
|---|---|---|
| 自动送达率 | 不经 dispatcher 直接投递的追问占比 | 上升 |
| 误归属率 | 投递后被 worker 交回的比例 | 低于阈值（待定） |
| 唤醒成功率 | 唤醒后完成新一轮的比例 | 上升 |
| 重复投递 | 同一 `(task_id, inbox_id)` 多次投递 | 恒为 0 |
| dispatcher 负载 | 每 100 条入站的 dispatcher turn 数 | 下降 |
| 人工介入 | 每任务需人回答/确认的次数 | 下降 |

### C.13 B1 专属开放问题

1. 飞书单聊是否普遍暴露 reply-to？——已由 C.14.1 给出默认：**不依赖 reply-to**；待确认卡片按钮的渲染成本。
2. 一个聊天里两件并行的活、用户不 reply 时，反问"是 A 还是 B"会不会比直接分诊更烦？
   ——已由 C.14.3 给出默认：**反问一次、超时交分诊**；待观察误归属率。
3. 结果消息投递失败（无 `external_msg_id`）时，该轮还能否作为锚点？是否回退到 origin 锚点？
4. 交回后老任务是否保留 anchor 以便人显式回到它？保留会不会让面板"看起来还有活"？
5. 停止是否允许结构化卡片按钮（非 Web）？若允许，`nonce` 如何与任务绑定？
   ——已由 C.14.2 给出默认：**v1 仅 Web 面板，v1.1 再加卡片按钮**；待确认手机端需求。
6. `task_inputs` 的 `read` 由谁判定——worker 在 turn 开始读入时，还是模型显式确认？
7. 唤醒时是否要给用户一句"继续上次的 X"，以减少"我在跟谁说话"的困惑？
8. 多项目并行时，Thread 是否要带 `project_id` 做二次隔离？同一话题跨项目怎么办？
9. 话题被关闭/归档后，订阅是否自动释放？
10. 飞书消息编辑/撤回事件是否要更新 inbox/锚点？v1 是否直接忽略？

### C.14 三个待定项的建议（待 owner 确认）

> 以下是**建议默认值**，不是替 owner 决定；确认后回写 14/15/11。

#### C.14.1 单聊 reply-to：不依赖它，用 `task_ref` 主锚点 + reply-to 增强

**事实**：飞书消息事件里有 `parent_id` / `root_id`（回复关系与话题根），但**单聊客户端是否暴露"回复"入口不可保证**。
把续接能力押在 UI 上不稳。

**建议**：

1. `tasks.task_ref`：随机 8–12 位、不可猜测、唯一；面板/消息只显示"短码 + 标题"，不暴露内部 `task_id`。
2. 任务结果与关键提问的卡片页脚带 `task_ref` 和"继续这个任务"按钮；按钮回调携带 `task_ref`。
3. 路由优先级：**`task_ref` → `root_id`/`parent_id` → 无锚点回退**（C.4 规则 9/10）。
4. `task_ref` 只作**路由提示**，不授予权限；仍校验 actor、Grant、S1。
5. 任务 `stopped/failed` 后 `task_ref` 失效（查状态），但保留历史用于审计。
6. v1 **不做文字模糊解析**（用户手打短码不自动路由）；手打走 `dispatcher`，由 S2 判断。

**理由**：DM 回复 UI 不可控；卡片按钮是确定性入口；短码可复制但不承诺文字解析，避免"猜短码"的歧义。
**代价**：结果卡片要渲染按钮/页脚；多一个唯一字段与一次查库。
**验收**：场景 17/18；DM 不暴露 reply-to 也能续接。

#### C.14.2 停止：v1 只 Web 面板 + 全局 kill switch

**建议**：

- v1：**Web 面板单任务 stop + 全局 kill switch**；不开放 IM 自由文本停止，也不做卡片停止按钮。
- v1.1：签名卡片按钮——`task_ref` + 一次性 `nonce` + 5 分钟过期 + 消费即失效 + 记录 actor；
  可复用审批的 nonce 模式，但**不复用审批语义**。
- 自由文本"停"→ `dispatcher`；它可以回答或（v1.1）反问带按钮，**不得由模型推断 stop**。
- v1 只做 stop（终态）；pause（按住）后置，二者不混。

**理由**：stop 是破坏性/终态操作，需要"明确目标 + 明确 actor + 一次性令牌 + 审计"；
自由文本歧义大（"停一下""先别改"可能只是暂停或补充）；模型不得声称"人要求停止"。
**代价**：v1 低；v1.1 需要动作 nonce 与卡片。
**验收**：面板 stop 释放全部 relation；后续消息分诊；重复 stop 幂等；非法 actor 拒绝。
**待确认**：手机端是否强需停止入口；若强需，走 v1.1 卡片，不走自由文本。

#### C.14.3 无锚点 + 多活任务：反问一次，超时交分诊

**建议**：

- 仅在"已配对 owner + 无锚点 + 聊天内 ≥2 个 live 任务"时触发；普通群无锚点**永不反问**，直接分诊。
- 发一张"哪一件"卡片：最多 3 个候选（按最近活跃排序，显示标题/项目/状态/短码）+ "都不是/新任务" + "先不处理"。
- 60 秒无应答 → 原消息交 `dispatcher`，记录 `disposition=ambiguous_timeout`。
- 选择候选 → 投递该任务；选择"新任务" → 交 `dispatcher`（不在卡片里直接建任务）；
  选择"先不处理" → 落 `dropped` 并静默。
- 同一 `inbox` 只发一次卡片；重复点击只接受第一次，后续幂等忽略。
- **绝不默认挂最近任务**；也不因超时自动新建任务。

**理由**：这是唯一"信息不足且必须二选一"的场景；一次结构化反问，比误归属或重复建任务都便宜；
比连续追问更克制（只问一次）。
**代价**：卡片发送 + 60 秒定时；可用 `inbox.status='awaiting_choice'` + 定时扫描，不新增表。
**验收**：场景 4；选择后正确投递；超时不挂任何任务；重复点击幂等。
**度量**：ambiguous 率、卡片应答率、超时率、误归属率。

**三个点的默认值汇总**

| 待定点 | 建议默认 | 主要代价 | 何时再评估 |
|---|---|---|---|
| 单聊 reply-to | 不依赖；`task_ref` 主锚点 + reply-to 增强 | 卡片渲染 + 字段 + 查库 | v1.1 看续接率 |
| 停止入口 | v1 仅 Web 面板 + 全局 kill switch | 手机端不便 | v1.1 加签名卡片 |
| 无锚点多活 | 反问一次，60 秒超时交分诊 | 一次打扰 | v1.1 看误归属率 |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-03 | 初稿：材料与方法、对照矩阵、A/B/C 三类、冲突复核、痛点影响、决策清单、实施顺序、开放问题 |
| 2026-11-03 | 第二轮：附录 C（B1 最小切片）——Thread 锚点定义、3 张新表、入站决策表、轮次/回执、AR35–37、18 个验收场景 |
| 2026-11-03 | 第三轮：C.14 三个待定项的建议默认——`task_ref` 主锚点、v1 仅面板停止、无锚点多活反问一次 |
| 2026-11-03 | 第四轮：附录 C 回写为草案——[11 §十三](11-架构锚定.md)（对象/修订/入站表/AR25 例外/AR35–37/验收）、[15 §九](15-数据与契约.md)（DDL/字段扩展/`session_routes` 迁移/视图/模块 API/契约测试）。回写时两处收敛：视图不跨模块 join；三个新接口定性为模块 API，端口数仍 13 |
| 2026-11-03 | 第五轮：B4 按 owner 决定整理为 **B4-b 修订版**——钉住 V2 的 7 个缺口、三层隔离、8 条规则、AR8 改写草案、数据模型增量、三阶段门禁与 8 项验收；D18-4 标记已定 |
| 2026-11-03 | 第六轮：B4 回写为草案——[11 §十四](11-架构锚定.md)（隔离单位/AR8 草案/三层机制/生命周期/资源键/验收）、[15 §十](15-数据与契约.md)（7+4 字段/`resource_locks`/状态机/模块 API/迁移/契约测试）。回写补 `prepare_state` 与 resource key 规范化 |
| 2026-11-03 | 第七轮：新增 **§十一 C 方案**（Router 唯一前台，owner 已定）——窄工具面、五条旁路、AR25 改写草案、`route_decisions`、`outbox` 归 ①、会话拓扑与 preset 调整、三阶段与 8 项验收；矩阵"双层"改为"取向不同" |
| 2026-11-03 | 第八轮：**C 方案回写 v2** —— 11（AR25 v2 / §5.3 旁路 / §5.8 G2 / §十三直达例外）、15（`outbox` 归 ① / `route_decisions` / `session_kind`）、17（`orchestrator` preset / `chat` 降级 / 验收 10 条）、13（Thread 作用域装配）、14（同 Thread 回复 + 3 条验收）、08（连续前台四条落在 A1/A2/A3/A6）；矩阵"双层"改为 ✅ |
| 2026-11-03 | 第九轮：**B1/B4 经 owner 确认生效 v2.1** —— 11（头部 v2.1、AR8 替换、AR35–AR37 并入、§十三/§十四状态改已生效）、15（§九/§十 状态改已生效、迁移约束）、18（头部/§四/B4.6–B4.7/§十一/附录 C 去草案标记）、AGENTS/README/HTML 版本标记同步 |
| 2026-11-05 | 第十轮：**增补 prime-agent 对照参考（v2.2，不改既有结论）** —— 13 §2.1 压缩预算/切点（先扣除 dsh 已有能力，只留三条增量）、§2.3 冷边界事实注入、§2.4 未完成工作保留、§3.4 快照校验、§4.2 专家消息寻址与配额；17 §二 预算终止语义（沿用 `paused`，不新增状态）、§5.4 自改复核门；18 §四 B3 增补 goal 预算外部实现；**联动** 05 新增 2d 装配与压缩参数、07/09 补全 compaction 已有能力并标出 3 条增量、12 §10.5 注明不单列插件行、15 `snapshots` 加 `baseline_ref`/`excludes_json`、16 §七 区分前置快照与备份、AGENTS §4 增补 |
