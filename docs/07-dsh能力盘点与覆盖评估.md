# 07 — dsh 能力盘点与覆盖评估

> **本文是实现侧文档**：盘点 dsh 提供什么、缺什么。
> **产品侧 SSOT 是 [`08-产品能力构想.md`](08-产品能力构想.md)**（111 项能力，纯产品视角，不含实现）。
>
> **两篇的关系**：08 定义"产品该有什么" → **[09](09-能力对照与实现路径.md)（已写）**做逐条对照（用 / 适配 / 自建 / 换方案）→ 本文提供实现侧证据。
> **不要用本文反推产品设计**——那会把"实现有什么"当成"产品该有什么"，正是本项目早期走过的弯路。
>
> 2026-10-15 重写：此前版本按 A-F 平铺分组，层次混乱且有遗漏。改为**六层能力栈**。
> 2026-10-16 补充：L3 机制澄清（多 agent 即隔离机制）、L5 实现骨架、子代理治理风险。

---

## 一、产品定位

> 「在微信上提供**服务器全域开发的能力**，类似于人通过 **claude code 或 cursor** 操作，
> **不只是单个会话**，要能做**多个项目和能力的开发而不打架**，提供**全面完善的管家能力**。」

### 五个属性

| # | 属性 | 含义 |
|---|---|---|
| **P1** | 载体 = 微信 | 首要长期入口，从手机发起 |
| **P2** | 体验 = 开发代理 | **自主多步**执行，不是问答；操作真实文件系统 |
| **P3** | 范围 = 服务器全域 | 不锁单 workspace，可跨项目 |
| **P4** | 并发 = 多项目多会话 | 多个项目同时开发，**互不干扰** |
| **P5** | 完备 = 管家主动性 | 不只你叫我做，还有巡检、摘要、待办、定时 |

### 关于 ADR

**不需要。** 本次是在独立新仓 `dsh-wfxm` 开发，**不修改 WFXM 本身**——
WFXM 保持全绿、继续作为可用系统与回退路径，其产品边界未发生变更，
因此不触发其 §4.3/§9 的 ADR 程序。

> （早前文档曾建议补 ADR，那是把"新建产品"误当成"改造 WFXM"，已作废。）

---

## 二、六层能力栈

能力不是平铺的，而是分层的。**低层不成立，高层全是空谈。**

```
L6 治理层  ── 敢不敢把 L1-L3 开到全域？
L5 管家层  ── 主动发现问题
L4 通道层  ── 从微信驱动 L1-L3
L3 隔离层  ── 多项目不打架          ← 本产品的核心难点
L2 编排层  ── 把原子能力变成任务
L1 原子层  ── 工具
```

---

### L1 原子能力 —— 工具本身

> 解决：agent 到底能碰到什么。

| 能力 | dsh | Butler |
|---|---|---|
| 文件读写 | ✅ `packages/fs/tool-fs` | ✅ 但锁在 `BUTLER_V5_WORKSPACE_ROOT` |
| **工作区外**（P3 全域） | ✅ workspace 可配 | ❌ 路径不能逃逸 root |
| 命令执行 | ✅ 一次性 + `packages/shell` | ✅ allowlist 白名单 |
| **持久 shell** | ✅ `terminal-bash`：「persistent interactive shell… **stays alive across tool calls**」 | ❌ 只有一次性命令 |
| 搜索 | ✅ grep/rg 类工具 | ✅ |
| **代码语义理解** | ✅ `packages/lsp`（定义/引用/实现/hover，**按 workspace 各起一个 server**） | ❌ 无 |
| 网络 | ⚠️ 可执行但**无管控**（沙箱明确 out of scope，无 `--unshare-net`） | ⚠️ 有 3 档 profile |
| 版本控制 | ✅ 有 git 类工具 | ✅ |

**缺口**：网络管控（dsh 无）、服务/进程管理（两边都无）。

---

### L2 编排能力 —— 把原子能力变成任务

> 解决：能不能像 Claude Code 那样**自己干完一串事**而不逐步问你。

| 能力 | dsh | Butler |
|---|---|---|
| 多步自主执行 | ✅ `packages/core/agent-loop`（`ReactLoopAgent`） | ⚠️ 有 loop，但决策 ADT 受限 |
| **决策失败时的行为** | ✅ 工具调用配对不变式，`history ends with unresolved tools` → 直接抛 `INVALID_REQUEST` | ❌ **静默降级**（decode 失败落 plain-text→Respond），这正是「聊着聊着就乱掉」的成因 |
| 计划/待办 | ✅ `packages/todo`（跨 turn 与重开 session 存活） | ⚠️ 有但简化 |
| **长上下文管理** | ✅ `packages/compaction`（`/compact` 手动 + 自动压力触发） | ❌ 无 |
| 子代理 | ✅ `packages/subagent`（Local spawn/fork **保留持久会话**） | ⚠️ 有但简化 |
| **可中断可恢复** | ✅ `AgentFactory.createAgent()` + **`resumeAgent()`**；session 支持 fork/resume/replay | ⚠️ 只能恢复自己那一种挂起状态（approval） |
| 后台长任务 | ✅ `packages/jobs` | ❌ 无 |

**这是 dsh 优势最大的一层**，且直接对应 owner 的第一诉求（对话不再乱）。

---

### L3 隔离能力 —— 多项目不打架（P4，**核心难点**）

> 解决：A 项目和 B 项目同时开发时，会不会互相污染、互相阻塞、互相破坏。

必须区分**五种不同的隔离**，很多产品只做了前两三种：

| # | 隔离类型 | 问的问题 | dsh | Butler |
|---|---|---|---|---|
| 1 | **文件根隔离** | 它能看见哪些目录？ | ✅ `packages/workspace` | ⚠️ 单一 root |
| 2 | **能力可见性隔离** | 它能用哪些工具/插件？ | ✅ `packages/preset/agent-preset`：「Declare several presets and **let sessions select one**」 | ⚠️ 全局工具表 |
| 3 | **会话上下文隔离** | 它记得什么？ | ✅ `packages/core/session` | ⚠️ 同 Conversation 共享 history |
| 4 | **贡献集生命周期隔离** | 它注册的东西会不会残留/被别人继承？ | ✅ `packages/core/scope`：「isolated contribution set with a shared lifetime… **Disposing a scope removes everything owned by it**」 | ❌ 无此概念 |
| 5 | **资源互斥** | 两个任务同时写同一文件/抢同一端口？ | ❌ **完全没有** | ❌ 无 |

**辅证**（dsh 确实把隔离做进了各子系统，不只是概念）：

- jobs：「Ownership is scoped to the agent session, so **other agents cannot inspect or stop the job**」
- todo：「**only the owning agent session can change it**」
- lsp：「Queries are serialized per server and workspace, while **different workspaces can run in parallel**」

#### 缺口的准确边界（别误判严重性）

- **不同项目各改各的** → 1-4 全部原生，**不会打架**
- **同一项目内多会话并行改同一批文件** → **会打架**，dsh 不管

所以 P4 的真实风险不在"多项目"，在"**同项目内的并行编辑**"。
解法通常是 git worktree / 文件锁 / 任务粒度约束，**必须自己定策略**。

#### 另一个容易被忽略的隔离维度

| # | 隔离类型 | 问的问题 | 状态 |
|---|---|---|---|
| 6 | **认知隔离** | A 项目的上下文会不会漏进 B？ | ⚠️ 语义问题，见 L5 的知识跨项目 |

#### 机制澄清：这六种隔离**不是六套独立机制**，多 agent 就是那个机制

上表容易被误读成"dsh 提供了 6 种隔离子系统"。实际不是。
**隔离的实现机制只有一个：多 agent + scope。** 上表是它的六种表现：

`packages/core/agent/README.md` 自述：

> create or resume live agents… Plugins, UI, hooks, and orchestrators can also observe or
> intercept agent activity and **apply capabilities to one agent without affecting others**.

映射关系：

| 你的需求 | dsh 机制 |
|---|---|
| 同时在两个项目上干活 | 两个 session → 两个 **agent** |
| 每个项目只能用该项目的工具 | 每个 agent 选自己的 **preset**（"let sessions select one"） |
| A 的上下文不进 B | 各自 session 上下文隔离 + **`scope`**（贡献集按 agent 隔离，dispose 清空） |
| 后台任务互不干扰 | jobs 所有权按 agent session 隔离 |
| 待办互不干扰 | todo 只有 owning agent session 能改 |
| 两边 LSP 并行 | 按 workspace 分别起 server，跨 workspace 并行 |

**结论**：owner 提出的"多项目不打架可以依托多 agent 能力吧"——**是对的**。
本节列的六种隔离就是多 agent 能力的六种表现。

**唯一例外是第 5 种（资源互斥）**：多 agent 隔离的是**能力与认知**，
不隔离**物理资源**。两个 agent 同时写同一文件、抢同一端口，dsh 不知道也不管。
这个缺口真实存在，但比"能力隔离"窄得多——因为**不同 workspace 之间根本不冲突**。

#### ⚠️ 新增风险：子代理共享治理

`packages/subagent/subagent/README.md`：

> Every child **shares** admission, cancellation, ownership, and discovery.

子 agent 与父 agent **共享治理**。

> 这与 WFXM 的既有规则方向相反 —— WFXM `product-boundaries §4.2` 写的是
> 「**子代理不继承父代理全部权限，且默认不可再委派**」。
>
> 若使用 D5（并行子任务，对应 08 的 D5），**必须先验证子代理的权限边界**：
> 它继承了什么？能不能再往下委派？跨项目的子代理会不会带上不该有的能力？
> 这一条 Step 1 未覆盖，需在实现 D5 之前单独验。

---

### L4 通道能力 —— 从微信驱动

> 解决：手机这个载体跟终端有什么不同，凭什么能驱动 L1-L3。

| 能力 | 为什么微信需要 | dsh-im 现状 |
|---|---|---|
| 收发 | 基本 | ✅ iLink 官方协议 |
| **长任务进度可见** | 移动端没终端，不能干等一条消息几分钟 | ⚠️ **只有 typing + 1800 字分段**（9 渠道里最弱，飞书有原生 thinking 过程） |
| 附件 | 看代码/看结果 | ✅ 图片/文件 |
| **审批闭环** | 高危操作要能确认 | ✅ 文字/yes-no（非可点卡片） |
| **入站准入** | 这是个能操作你服务器的远程入口 | ❌ **无白名单，默认 fail-open** |
| **异步任务** | 网络不可靠，长任务不能绑定一个长连接 | ⚠️ 需验证长轮询断线后的恢复 |
| **无屏幕假设** | 不能依赖终端可视化 | ✅ dsh 有 `session/event` 流可推送 |

> **L4 是 dsh-im 最弱的一层**，也是最可能需要自己写插件的一层。
> 但注意：**它弱不影响 L1-L3 的价值** —— 那是 dsh 本体的能力。

---

### L5 管家能力 —— 主动性

> 解决：除了你叫我做，我该做什么？

| 能力 | dsh | Butler |
|---|---|---|
| 定时提醒 | ✅ `packages/schedule/tool-schedule`（durable，per-session） | ⚠️ 有但简化 |
| 待办 | ✅ `packages/todo`（支持并行模式） | ⚠️ 有 |
| 后台长任务 | ✅ `packages/jobs` | ❌ |
| **摘要 / 周报** | ❌ 自建 | ✅ 有雏形（task_digest） |
| **巡检 / 健康检查** | ❌ 自建 | ❌ |
| **服务/进程管理** | ❌ 只有 jobs（长任务），不是 systemd 式服务管理 | ❌ |
| **跨项目知识** | ❌ workspace 隔离，无「项目之上」的概念 | ⚠️ PK recall **故意跨项目**（D43 闭环） |

> ⚠️ **最后一行的语义冲突**：dsh 的隔离原则是 workspace 为界，Butler 刻意做跨项目召回。
> **两者不能同时成立**。这是产品决策，必须显式选：
> (a) 显式跨 workspace 查询　(b) 知识挂 workspace 不跨　(c) 分层（私有 + 一层共享）

> 「服务/进程管理」是**「管家」属性最实的一块**（起停服务、看日志、重启），
> 而 dsh 和 Butler **都没有**。这是 P5 目标下最大的空白。

#### 管家能力的实现骨架（dsh 给到哪、剩下七块怎么拼）

`packages/schedule/schedule/README.md` 自述：

> Schedule delivers one-shot, fixed-rate, daily, weekly, and cron wall-clock reminders
> **as follow-up messages in their original Session**… **The Host restores a cold Session when delivery is due.**

即：**能定时、能唤醒冷 session，但投递目标是"原来那个 session"，不能凭空开新 session。**

**这条约束决定了实现形态**：管家需要一个**常驻角色的固定 session**，而不是每次现开。

| # | 组件 | 怎么做 | 谁做 |
|---|---|---|---|
| ① | **触发源** | dsh schedule（cron） | ✅ dsh |
| ② | **管家 session** | 建一个**固定的、专门的**巡检 session，带只读 preset | 配置 |
| ③ | **巡检逻辑** | 检查什么——服务存活、磁盘、依赖更新、日志异常 | ❌ 自建 |
| ④ | **状态存储** | 巡检历史 / 已知问题 / 基线（避免重复报同一件事） | ❌ 自建 |
| ⑤ | **报告生成** | 消费 session event 流 → 日报/周报 | ❌ 自建 |
| ⑥ | **主动推送** | 微信 outbound，不等用户问 | ⚠️ dsh-im，待验 |
| ⑦ | **服务管理** | systemd / docker 封装 | ❌ 自建 |

**两条设计红线**

1. **管家只"发现 + 报告"，不"擅自修复"。**
   发现问题后主动去修，等于让一个不受监督的进程改你的服务器。
   修复必须是 owner 确认后的动作。
2. **管家 session 与项目 session 分离。** 巡检 session 只读、有独立身份和记忆，
   不得污染任何项目 session。

**难点不在机制，在定义"该管什么"（③）。** ①⑥ dsh 都给了，③④⑤⑦ 是工程量，
但巡检清单完全取决于 owner 实际在管什么——**这是产品决策，不能替 owner 定**。

**建议推进顺序**（从省事到重）：

1. **每日摘要（⑤）** —— 不需要任何判断，只把已有 session 记录讲清楚。**先做这个验证推送链路**
2. **服务存活巡检（③）** —— 范围最小，先覆盖 owner 已经在管的服务
3. **服务管理（⑦）** —— 起停/重启/看日志，"管家"最实的一块
4. 依赖更新、日志异常、磁盘预警（③ 的扩展）

---

### L6 治理能力 —— 敢不敢把 L1-L3 开到全域

> 解决：P3「服务器全域」+ P1「微信可达」这个组合的爆炸半径怎么控。

这是**新仓从第一天就要面对的问题**：一旦把 L1-L3 全域开放，微信那头就是一把指向你整台服务器的钥匙。

| 能力 | dsh | Butler |
|---|---|---|
| 破坏性操作确认 | ✅ `interaction/user-approval` + `permission-presets` | ✅ PolicyGate |
| **审批可插拔** | ✅ `approval/request` 是 waterfall 事件，可挂自己的应答器 | ✅ 但绑定自己的 loop |
| 文件沙箱 | ✅ bwrap+landlock+seatbelt+win-acl，**无网络维度** | ✅ 含 3 档网络 profile |
| 入站准入 | ❌（见 L4） | ✅ |
| 审计 | ⚠️ durable SessionEvent，**无 actor、无落库** | ✅ `audit_events` 表含 actor/correlation_id |
| **授权限域限时可撤销** | ❌ 全仓零命中 | ✅ ScopedGrant |
| **网络管控** | ❌ 明确 out of scope | ✅ 3 档 profile |
| Kill switch | ✅ 有 | ✅ 有 |

**这里要澄清一件事**：

新仓不是要照搬 Butler 那套 12 条准入条件的完整 ScopedGrant 体系。
**「单 owner 全域开发」≠「多租户 SaaS」**，要求可以大幅简化。最小可用形态：

1. 破坏性操作确认（dsh approval 已覆盖大半）
2. 路径 / 命令白名单
3. 全局 kill switch
4. 审计字段（含 actor）
5. 撤销路径

**只有真正用起来、发现"确认"太粗或太烦时，再往上限。**

---

## 三、覆盖度矩阵

| 层 | dsh 原生 | 需自建 | 说明 |
|---|---|---|---|
| L1 原子 | 7/9 | 网络管控、**服务/进程管理** | 服务管理两边都缺 |
| L2 编排 | **7/7** | — | **dsh 优势最大的一层** |
| L3 隔离 | 4/5 | **资源互斥策略** | 前四种原生且做进了各子系统 |
| L4 通道 | 3/7 | **流式进度、入站白名单**（+ 审批体验优化） | **dsh-im 最弱的一层** |
| L5 管家 | 3/7 | **服务管理**、摘要、巡检、**跨项目知识语义决策** | 「管家」属性最大空白 |
| L6 治理 | 3/8 | 入站白名单、审计 actor、限域授权、网络管控 | 需按最小形态做 |

**结论**：

1. **L2 是决定性优势层**，且直接对应 owner 的第一诉求（对话不再乱）。
2. **L3 前四种隔离原生**，只缺资源互斥 —— 这是 P4 的真实风险点，且必须自己定策略。
3. **L4 是最弱的一层**，但它是**渠道适配问题，不是运行时问题** —— 补它不会削弱 dsh 本体的价值。
4. **L5 的「服务/进程管理」两边都缺**，这是「管家」目标下最大的功能空白，需要主动立项。
5. **L6 要按最小形态做**，不要一上来就重建完整 ScopedGrant。

---

## 四、验收标准

> **这些 V 编号来自实现侧盘点（本文）。**
> **产品侧的能力清单与优先级以 [`08-产品能力构想.md`](08-产品能力构想.md) 为准**（A1-M10 共 111 项）。
> 两者的桥是 [09-能力对照与实现路径](09-能力对照与实现路径.md)（已写）：把 08 的每项能力标为「dsh 直接可用 / 需适配 / 需自建 / 换方案」。
> **V 编号只用于 Step 1 的快速验证**；完整验收应以 08 的 MVP 边界为准。

### 成立条件（不成立则方案不成立）

| # | 验收 | 怎么测 |
|---|---|---|
| **V1** | **多项目并行不打架** | 两个 workspace + 两套 preset，微信同时发两条任务；确认能力集互不可见、上下文互不泄漏、job 互不可停、LSP 并行 |
| **V2** | **同项目并行改文件** | 同一 workspace 两条会话改同一文件，观察是否静默覆盖；据此定策略 |
| **V3** | **对话不再劣化** | 连聊 10+ 轮，检查是否有 Butler 那种"突然跑偏"；对照 CI 日志里 `decodeDecision failed` 类现象 |

### 能力项

| # | 验收 | 对应层 |
|---|---|---|
| V4 | 会话可 resume：关进程重开后接着聊 | L2 |
| V5 | 长任务（>2 分钟）在微信能看到进度 | L4（**dsh-im 当前不达标**） |
| V6 | 微信里能完成一次需确认的操作 | L4/L6 |
| V7 | 微信端非授权发送者被拒绝 | L4/L6（**dsh-im 当前不达标**） |
| V8 | 全域可执行：workspace 外读写 + 行为可审计 | L1/L6 |
| V9 | 定时任务触发并在微信投递结果 | L5 |
| V10 | 能起停一个真实服务并看日志 | L5（**两边都缺，需立项**） |

**V1/V2/V3 是分叉点**，其余是能力项。