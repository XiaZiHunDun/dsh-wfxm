# 02 — Butler 能力 ↔ dsh 对照

> 本文所有结论来自对 `/home/ailearn/githubpro/deepseek-harness` (`v0.2.1-alpha.3`) 的源码阅读，
> 每条带 `file:line`。

## 汇总

| Butler 能力 | dsh 对应物 | 能否直接接 |
|---|---|---|
| Agent loop / 工具调用编排 | `packages/core/agent-loop`（`ReactLoopAgent`） | ✅ **dsh 更强，Butler 应弃** |
| 会话上下文与历史 | `packages/core/session` — append-only `SessionEvent` log（`ctx.sessions`） | ✅ **dsh 更强，Butler 应弃** |
| 流式响应 | `agent/assistant-stream` + `llm/stream` | ✅ **Butler 完全没有** |
| LLM 适配层 | `packages/llm/llm-deepseek`（+ `llm-pi-ai` 广谱目录） | ✅ **Butler 应弃** |
| MCP client | `packages/mcp/mcp-client` | ✅ dsh 有（仅 client，无 server） |
| 沙箱（文件维度） | `packages/sandbox`（bwrap + landlock + seatbelt + win-acl） | ✅ **dsh 更强** |
| 子代理 / 委派 | `packages/subagent`（12 个包） | ✅ **Butler 应弃** |
| 上下文压缩 | `packages/compaction` | ✅ **Butler 没有** |
| LSP / 技能 / 定时 / 任务 | `lsp` / `skill` / `schedule` / `jobs` | ✅ **Butler 没有** |
| 浏览器 / 电脑操作 | `browser-use` / `computer-use` | ✅ **Butler 没有** |
| **策略门（三分支 + 风险分级）** | 无 | ❌ **自建** |
| **ScopedGrant（过期+范围+跨重启恢复）** | **全仓零命中** | ❌ **自建** |
| **沙箱网络 profile（deny/allow/allowlist）** | 明确 out of scope | ❌ **自建** |
| **身份 / subject 模型** | `packages/identity` = 100 行匿名 UUID | ❌ **自建** |
| **审计落库（actor/subject/correlationId）** | 有 SessionEvent，无 actor、无落库 | ⚠️ **自建持久化层** |
| **审批流程（挂起→回复→恢复）** | `packages/interaction/user-approval` | ⚠️ **骨架可复用，耐久性自建** |
| **外部渠道（微信/Slack/Telegram）** | `packages/experimental/webhook` | ⚠️ **实验性，且无幂等去重** |
| 项目知识 + 跨项目召回 | 无（dsh 是单会话连续性，无"项目"概念） | ❌ 自建 |
| 记忆候选晋升流程 | 无 | ❌ 自建 |
| 中文 owner 命令集 + jargon 映射 | 无（英文 slash commands） | ❌ 自建 |

---

## dsh 已经有的（比 Butler 强）

### Agent loop

`packages/core/agent-loop/src/agent.ts:98` — `ReactLoopAgent implements Agent`，
服务类 `AgentLoop extends Service implements AgentFactory`，注册 key `ctx.agentLoop`。

turn/step 流程（`docs/architecture.md:83-104`）有明确的瀑布事件可拦截：
`agent/pre-step`（可改写/拒绝输入）、`agent/request`、`llm/stream`、
`tools/pre-execute` / `tools/execute` / `tools/post-execute`、`agent/turn-stopping`。

**loop 可以整体替换**：`ctx.agents.setFactory(factory)`（`packages/core/agent/src/index.ts:360-375`），
`AgentFactory` 接口只有 `createAgent()` + `resumeAgent()` 两个方法 —— 全仓最小的接管面。

### 工具执行管线 ≈ Butler 的 policy-gate + capability-boundary

`docs/tool-execution-pipeline.md` 的 mermaid 图逐层对应：

```
tool/call（持久化会话事件）
  → tools/pre-execute waterfall        ← allow / deny / ask 判定
  → monotonic guards                   ← 可 deny，任何 guard 不能 force-allow
  → ctx.approval（ask → 一次性询问）
  → tools/execute waterfall            ← timeout / retry / metrics
  → tool body
  → fs/write-intent | fs/edit-intent   ← 读改写检查
  → tools/post-execute waterfall       ← accept / block / replace
  → tools/result（冻结终态，持久化会话事件）
```

### 会话日志

append-only `SessionEvent` log（`packages/core/session`）是模型上下文的真相源。
`tool/call` + `tool/result` 都是**持久化事件** —— 天然就是审计流。

---

## 必须自建的（dsh 没有）

### 1. ScopedGrant —— 全仓零命中

grep `ScopedGrant` / `scopedGrant` / `grantStore` / `grant_store` 在整个 dsh 仓**零结果**。

dsh 的审批是**一次性**的（`packages/core/tools/src/index.ts:1724-1740`）：

> `allowed-once` proceeds; **the three non-grants deny**

封闭词表：`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
（`packages/interaction/user-approval/src/types.ts:29`）。

对比 Butler：

| | Butler | dsh |
|---|---|---|
| 审批 | 通过后**签发票据** | 同步弹一次窗 |
| 票据 | 带过期 + 范围限制 + 绑 run | `allowed-once`，用完即弃 |
| 跨重启恢复 | 有（`approval-resume`，`store stateless → pending steps fully recoverable`） | **无** |

**审批"体验"能平移，审批"耐久性"不能。** 这是 Butler 最值得带走的一件东西
（D83 T3 的硬化就是在守这个：重启后过期 → 不发 grant、run 转终态）。

### 2. 沙箱网络维度 —— 明确排除

`packages/sandbox/src/index.ts:25-29` 原文：

> **Network and process visibility are outside this vocabulary.**

策略词汇只有 `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`（`:30`）。

实测 bwrap 参数（`packages/sandbox/sandbox-local/src/profiles.ts:17`）：
`--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`
—— **没有 `--unshare-net`，没有任何网络参数**。

Butler 的三档网络 profile 在 dsh 里无对等物。

### 3. 身份 / subject 模型 —— 名不副实

`packages/identity` 只有一个子包 `anonymous-user-id/`，**100 行 src / 105 行测试 / 1 spec**，
README 自述用途是"correlate telemetry, feedback, and DeepSeek requests"。
**没有用户身份、没有 subject 模型、没有多租户。**

Butler 的一切（审计 actor 过滤、owner 专属授权、per-owner rate limit）都建在 subject 之上。

### 4. 审批的接缝（好消息）

`packages/interaction/user-approval/src/types.ts:81-94`：

```ts
'approval/request'(
  this: Scoped<Agent>,
  req: ApprovalRequestEvent,
  next: () => Promise<ApprovalOutcome>,
): Promise<ApprovalOutcome>   // @mode waterfall
```

**这是个 waterfall 事件** —— 插件可以注册 listener，返回结果抢占，或 `next()` 委托。
按 `Scoped<Agent>` 作用域过滤。

宿主源码里有一段注释说明 `prepend: true` 的 listener 会排在任何 gate listener 之前，
说明这个用法在 0.2.x 上是被预期的。

**所以：微信里点确认可以做到** —— 插件监听 `approval/request`，把问题发到微信，
挂住 waterfall（返回 promise）直到用户回复。语义上与 Butler 的 `waiting_approval` 一致。
社区插件 `dsh-im` 就是这么做的。

### 5. 审计持久化

dsh 有 `approval/asked` / `approval/decided` 这类 durable SessionEvent（`id` 配对），
但**没有落库、没有 actor 维度、没有 correlationId**。
Butler 的 `audit_events` 表（`actor` / `subject` / `action` / `correlation_id` 分列，migration 0013/0014）
需要自己接。

---

## 两个必须避开的坑

### credentials 的 scope 语义冲突

`packages/credentials/src/types.ts:17-22` —— key 是 `<scope>/<id>`，
但这里的 **scope 是"持有该记录的插件名"，不是权限范围**。

跟 Butler 的"授权范围"同名不同义。接入时极易踩。

`CredentialInfo` 只有 `{ configured, source, writable }`，**无过期**（无 expiresAt / TTL）。

### experimental/webhook 无幂等去重

`packages/experimental/webhook/README.md` 明确写：repeated delivery runs the rules again。
Butler 现有的 replay dedup（D74）能力需要自己补。

---

## 参考

- dsh 架构总纲：`docs/architecture.md`
- Cordis 五概念：`docs/cordis-primer.md`
- 最小插件示例：`packages/todo/tool-todo/src/index.ts`
- 工具执行管线：`docs/tool-execution-pipeline.md`
- capability seam：`docs/capability-seams.md`