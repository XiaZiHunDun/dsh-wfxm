# 04 — WFXM（Butler）资产盘点

> 分清哪些要搬、哪些是负债、哪些是唯一真相源。
> **判断依据**：Butler 里真正独特的东西不是 agent loop（dsh 更强），而是治理模型和中文产品语义。

## A. 应该弃（dsh 已有且更成熟）

| Butler | 位置 | dsh 对应 |
|---|---|---|
| 自研 agent loop | `packages/runtime/src/execution/conversation-loop.ts` | `packages/core/agent-loop`（`ReactLoopAgent`） |
| 决策解码 ADT | `packages/runtime/src/decision.ts`（5-tag 白名单） | 原生 tool calling + 配对不变式 |
| 会话上下文 | `packages/persistence` 的 run/conversation 表 | `packages/core/session` append-only log |
| LLM 适配层 | `packages/adapters/src/llm/`（4 个 adapter） | `packages/llm/llm-deepseek` + `llm-pi-ai` |
| 沙箱封装 | `apps/api/src/workspace-tools.ts` 的 bwrap 调用 | `packages/sandbox`（bwrap+landlock+seatbelt+win-acl） |
| MCP client | `apps/api/src/mcp-*.ts` | `packages/mcp/mcp-client` |
| 子代理委派 | `apps/api/src/subagent-worker.ts` | `packages/subagent`（12 包） |
| Provider 逃生舱 | `DEEPSEEK_BASE_URL`（`cf5f5510` 刚加） | dsh 自己有 provider 配置 |

> **`cf5f5510` 的 `DEEPSEEK_BASE_URL` 迁移后成死代码。** 那批 commit 本身不是白做（main 当时是坏的），
> 但别在上面继续建。

## B. 必须搬（无对等物）

按"丢了会痛"的顺序：

### B1. ScopedGrant —— 最高优先级

**能力**：审批通过后签发一张**带过期时间 + 范围限制 + 绑定 run** 的票据；
run 挂起等 owner 回复；跨进程重启可恢复；过期/耗尽则拒绝。

**dsh 里**：`ScopedGrant` / `grantStore` / `grant_store` 全仓零命中。只有 `allowed-once`。

**实现位置参考**：
- `apps/api/src/approval-resume.ts`
- `apps/api/src/wechat-inbound-butler.ts` 的 `waiting_approval` 分支
- `packages/persistence` 的 `scoped_grants` 表

**dsh 接缝**：`approval/request` waterfall + 自建持久化票据表。
参照 D83 T3 的硬化（重启后过期 → 不发 grant、run 转终态；新 store 实例恢复）。

### B2. 策略门（PolicyGate）

**能力**：每个副作用操作前判定 allow/ask/deny，风险分级（high-risk → 直接 deny）。

**dsh 里**：`interaction/user-approval` 只有二元的 `'ask' | 'never'`；
唯一的三值判定器 `experimental/auto-review` 明确标 experimental，且其 README 自陈
"it can allow unsafe actions, deny useful work, and spend additional tokens"。

**dsh 接缝**：`tools/pre-execute` waterfall（allow/deny/ask）+ `ctx.tools.guard()` 单调守卫。

### B3. 审计落库

**能力**：`audit_events` 表，`actor` / `subject` / `action` / `correlation_id` 分列
（migration 0013 correlation_id、0014 actor），支持 per-actor 过滤。

**dsh 里**：有 durable SessionEvent（`approval/asked` / `decided` / `tool/call` / `tool/result`），
**但无落库、无 actor 维度**。`packages/identity` 只有 100 行匿名 UUID。

**dsh 接缝**：消费 session event 流写进 Butler 的库表。**保留现有 schema，不要重设计。**

### B4. 项目知识 + 跨项目召回

**能力**：per-project 知识空间、PK（project knowledge）跨项目召回、glob 抓取与提升。

**dsh 里**：无。dsh 是单会话连续性，**没有"项目"这个概念**。

**位置**：`apps/api/src/project-knowledge-*`、`project-knowledge-glob`

### B5. 记忆候选晋升流程

**能力**：候选 → 确认 → 晋升 → 回滚（3d promote / 7d rollback）+ audit。

**dsh 里**：无。

**位置**：`apps/api/src/auto-promote-sweeper.ts`、`durable-memory-*`

### B6. 中文 owner 命令集 + jargon 映射

**能力**：`/记住` `/待办` `/撤销` 等中文内联命令；内联审批认 `确认`/`👌`/`y`/`n`/`👍`/`❌`；
owner-facing 错误统一映射为中文，不泄漏内部术语。

**dsh 里**：英文 slash commands，交互式审批是文字/yes-no。

**位置**：`apps/api/src/wechat-inbound-commands.ts`、`inline-approval-intent.ts`、
`owner-jargon` 相关 helper

### B7. 沙箱网络 profile

**能力**：3 档 —— network-deny / network-allow / network-allowlist。

**dsh 里**：明确 out of scope（`packages/sandbox/src/index.ts:25-29`），
bwrap 参数无 `--unshare-net`。

**位置**：`packages/runtime/src/sandbox/`、`apps/api/src/lib/dns-recheck.ts`（MCP SSRF 侧）

## C. 唯一真相源 / 保留资产

### C1. iLink 微信客户端 —— 非测试 1,228 行

`packages/adapters/src/wechat/`：

```
ilink-protocol.ts      协议层
ilink.ts               核心客户端
ilink-outbound.ts      出站
ilink-media.ts         媒体
ilink-media-crypto.ts  媒体 AES 加密（对应 iLink CDN 上传加密要求）
ilink-asr.ts           ASR
secret.ts              凭证
channel-port.ts        Channel Port 抽象
env-file.ts            环境变量读取
index.ts               包导出
```

**这是 WFXM 目前最有价值的非治理资产** —— 完整、带测试、用的是与社区插件相同的官方 iLink 协议。

- 若直接用 `dsh-im`：**不动它**（YAGNI）
- 若将来自己写 dsh 渠道插件：**这是 0 行协议成本的关键**

### C2. 58 场景 acceptance 场景库

`butler-v5/tests/acceptance/scenarios/` —— **58 条**手工编码的"好 bot" fixture（A/B/C/D 四类），
覆盖真实 owner 开发任务 + 开放性任务 + 边界 + 多 turn 组合。
（原文括号内编码表只列到 39 条，未含后续新增的 `C-O-*` 与 `D-chain`。）

**这是产品行为的回归网。** 迁到 dsh 后它不能直接跑（harness 深度绑定 `runButlerLoop`），
但**场景本身可以复用为 dsh 的验收基准** —— 重写成 dsh 插件的验收用例。

### C3. 产品设计文档

`butler-v5/DESIGN.md`（目标架构）、`docs/FEATURES.md`、`docs/TODO_DEFERRED.md`
（25 项延后项 + 触发条件）、`docs/AUDIT_FINDINGS.md`、`docs/FEEDBACK.md`

**§18 延后项的"触发条件"制度值得保留** —— 它把"不做"也当成显式决策记录，
换框架后这套纪律继续有用。

---

## D. 明确的负债

| 项 | 说明 |
|---|---|
| `pnpm` 版本 9.15.0 | dsh 要 11.28.5，`allowBuilds` / `minimumReleaseAgeExclude` 是 pnpm 10+ 专有 |
| Node 22.13.0 | dsh 要 `^22.19.0 \|\| >=24.0.0` |
| 自研 smoke harness 的一半 | dsh 有自己的 profile/patch 体系 |
| `docs/` 里 14 条死链 + 三套 ship 计数口径 | 与迁移无关，但别带过去 |

---

## E. 打包建议（若要抽独立包）

Butler 的 iLink 代码现在寄生在 `packages/adapters/`。若最终要弃 Butler，这套代码是唯一的微信接入资产，
值得有独立身份。

| 方案 | 说明 |
|---|---|
| (a) 直接拷进插件仓 | 最省事，但从此两份 |
| (b) 插件仓依赖 `@butler/adapters` | 单一真相源，但要处理依赖与版本 |
| **(c) 抽成独立小包，两边都用** | **最干净**，多花一步 |

**倾向 (c)**，但**先别做** —— 等确定要自己写渠道插件时再动手。YAGNI。