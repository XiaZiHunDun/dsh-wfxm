# Slice D Tasks — 真实 orchestrator 前台

> 依赖 `spec.md`（已实施）。每项独立可中止；**没跑的测试不算绿**。
> 环境：跑任何 node/tsc 前先
> `export PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH" && unset LD_LIBRARY_PATH`

## T1 新插件 `plugins/orchestrator`（`@dsh-wfxm/orchestrator`）

- [x] `package.json` / `tsconfig.json`（仿 executor；无 build 脚本，不跑 pnpm、不动 lockfile）
- [x] 手建软链：`plugins/orchestrator/node_modules/@dsh-wfxm/{gateway,tasks}`、`typescript`、`@types/node`；
      根 `node_modules/@dsh-wfxm/orchestrator`
- [x] `src/prompt.ts`：`buildDecisionPrompt`（项目名 + 同线程活任务 + 三选一契约 + 六条规则；零产品/协议名）
- [x] `src/decision.ts`：`extractJsonObject` / `parseDecision`（reply/task/queue 校验；R2/R3 拒绝；长度上限 4000/500）
- [x] `src/foreground.ts`：`createOrchestratorForeground`（活任务 → 补充指令入队列；新工作 → 建 R0/R1 任务；失败 → `degrade`）
- [x] `src/runner.ts`：`createDshDecisionRunner`（`dsh --profile headless --patch <asset> --json -`，NDJSON，超时/崩溃/错误拒绝，`DSH_PERMISSION_MODE=read-only`）
- [x] `assets/frontdesk.patch.yml`：persona + 禁用全部 `tool-*` 行
- [x] `src/index.ts` 导出

验收：`tsc -p plugins/orchestrator/tsconfig.json` 无错。

## T2 host 接缝（最小改动）

- [x] `plugins/host/src/foreground.ts`：`ForegroundOutcome` 三型加可选 `note`
- [x] `plugins/host/src/host.ts`
  - 新增 `foregroundFactory?: (stores) => ForegroundHandler`（`foreground` 优先，其次 factory，最后规则前台）
  - `turn.note` 存在时写 `route_decisions`（task-created→accept / input-queued→attach / reply→answer / none→ignore）
- [x] 重编 host：`node plugins/executor/node_modules/typescript/bin/tsc -p plugins/host/tsconfig.json`

## T3 验证套件 `plugins/orchestrator/scripts/verify-orchestrator.mjs`

- [x] 24 例：解析 7 / 提示 1 / host 接缝 4 / 降级 3 / 非文本与重放 2 / runner 5（含 fake dsh）/ 资产与静态 2
- [x] `stub-dsh.mjs`：同 argv、同 NDJSON（json / sleep / error / crash 四种模式，记录 argv 与权限模式）
- [x] lib 过期自建（按 `src/*.ts` 最新 mtime，不只看 `index.ts`）

验收：`node plugins/orchestrator/scripts/verify-orchestrator.mjs` → **24 passed, 0 failed**。

## T4 接线（默认仍规则前台，显式开关才启用）

- [x] `scripts/dev-web.mjs`：`DSH_WFXM_FOREGROUND=orchestrator`（`DSH_WFXM_DECIDE_TIMEOUT_MS` 默认 30000）
- [x] `scripts/e2e-smoke.mjs`：同上（真实飞书长连接路径）
- [x] `scripts/verify-live.mjs` 保持规则前台：它是**确定性**链路自检，不应引入模型抖动

## T5 验证记录

- [x] 真实 dsh 决策冒烟（三次，经 `createDshDecisionRunner`）：

```
你好            → 2951ms  {"action":"reply","text":"你好！有什么需要帮忙的吗？"}
看看磁盘占用    → 3359ms  {"action":"task","intent":"检查主机磁盘占用情况并汇报结果","risk":"R0"}
把日志清理一下  → 4187ms  {"action":"task","intent":"清理日志：先确认……","risk":"R1"}
```

- [x] dev-web（orchestrator 前台 + stub executor，真实 dsh 决策）：
  - `你好` → `foreground.action=reply`，`tasks=[]`，出站 1 条
  - `看看磁盘占用` → `task-created` + ack「收到，任务 8h99a67zp6…」→ worker 跑完 → 回执
- [x] 全仓回归：

| 套件 | 结果 |
|---|---|
| host | 19 ✅ |
| tasks | 90 ✅ |
| gateway | 100 ✅ |
| executor | 17 ✅ |
| snapshot | 18 ✅ |
| feishu | 31 ✅ |
| orchestrator | 24 ✅ |

## 6. 未做（下一片候选）

- 持久会话 / 提示缓存（现在每轮 3–4s 冷启动）
- 给 `orchestrator` 注册真实工具面（需子进程 → 宿主的回连通道）
- 卡片回调与审批按钮（`card.action.trigger`）
- ~~R0 只读快问快答的直答通道~~ → 已在切片 E 落地（见下）

---

# Slice E Tasks — 只读快问直答

> 依赖 `spec.md` 的 Slice E 段。每项独立可中止；**没跑的测试不算绿**。

## E1 探针 `createResourceProbe`

- [x] `plugins/svcops/src/inspection/resources.ts`：组合 `probeDisk` + `probeMemory` + `probeLoad1` + `os.cpus().length`，默认 3000ms
- [x] `plugins/svcops/src/index.ts`：导出 `createResourceProbe` 与 `ResourceProbeOptions` / `ResourceSnapshot`
- [x] `verify-inspection` 新增 2 例（fake runner 解析 df 42% + cores≥1；runner 抛错时 fail-soft 不抛）

## E2 快问规则 `quick-answer.ts`

- [x] `matchQuickRequest`：≤40 字 + 单句 + 名词 + 询问词 + 无动作词（任一不满足 → null）
- [x] `formatResources`：`磁盘已用 42% · 内存可用 61% · 负载 0.42（8 核）`；三项全 null → 返回 null
- [x] `formatTasks`：`进行中 N 个：` + `taskRef · status · intent`（`taskRef ?? '-'`）
- [x] `createQuickAnswer({ tasks, probe? })`：探针缺失 / 抛错 / 全 null → null 落回模型
- [x] `plugins/orchestrator/src/index.ts` 导出

## E3 接进前台

- [x] `foreground.ts`：空文本判断后、模型决策前调 `quickAnswer`；命中 → `{action:'reply', note:'quick-answer:<kind>'}`

## E4 验证套件

- [x] `verify-orchestrator` 24 → **30 例**（新增 6：资源命中不调模型且不建任务 / 动作词不命中 / 多句不命中 / 探针缺失落回模型 / 探针全 null 落回模型 / 任务进度直答）
- [x] `verify-inspection` 25 → **27 例**
- [x] 陈旧 `MULTI_CLAUSE` 误判（「看看磁盘占用，顺便帮我…」被直答）已修，修后复跑全绿

验收：`node plugins/orchestrator/scripts/verify-orchestrator.mjs` → **30 passed, 0 failed**；
`node plugins/svcops/scripts/verify-inspection.mjs` → **27 passed, 0 failed**。

## E5 接线与真机冒烟

- [x] `scripts/dev-web.mjs`：orchestrator 前台注入 `probe: createResourceProbe({ runner: spawnRunner })`
- [x] `scripts/e2e-smoke.mjs`：同上（`log('front:warn', ...)`）
- [x] 根 `node_modules/@dsh-wfxm/svcops` 手建软链（不动 lockfile）

- [x] dev-web 实测（orchestrator 前台 + stub executor）：

```
看看磁盘占用      → messages_ms=0.022507  回「磁盘已用 83% · 内存可用 72.5% · 负载 0.45（24 核）」  tasks=[]
把磁盘清理一下    → messages_ms=5.059833  task-created（仍走模型决策）
```

- [x] 全仓回归：

| 套件 | 结果 |
|---|---|
| host | 19 ✅ |
| tasks | 90 ✅ |
| gateway | 100 ✅ |
| executor | 17 ✅ |
| snapshot | 18 ✅ |
| feishu | 31 ✅ |
| orchestrator | 30 ✅ |
| svcops | 14 ✅ |
| svcops-inspection | 27 ✅ |

## E6 未做（本片边界）

- ~~unit 状态 / 端口 / 日志错误率仍未直答（需 ⑦ 巡检端口接进前台）~~ → 已在 Slice S 落地（见文末）
- 不同义词表扩展、语义匹配
- 跨线程任务进度查询
- 探针缓存与后台轮询（与「不做心跳」一致，明确不做）

---

# Slice F Tasks — 常驻会话与提示缓存

> 依赖 `spec.md` 的 Slice F 段。目标是把「每轮冷启动 dsh」换成「一个常驻 dsh 回答所有决策轮」。

## F1 依赖与可行性（先证后写）

- [x] 确认 dsh 侧有常驻入口：`--profile sdk` 走 JSON-RPC over stdio（`@deepseek-ai/dsh-sdk-client`）
- [x] 确认 `sdk` profile 在本机可启动；`~/.dsh/profiles/sdk` 首次使用自动就位
- [x] `pnpm add --filter @dsh-wfxm/orchestrator @deepseek-ai/dsh-sdk-client@0.2.1-rc.2`（**钉版本**）
- [x] 验证 `import('@deepseek-ai/dsh-sdk-client')` 可解析（`DeepSeekHarness`）

> 代价记明：该依赖拉入 **538 个包**、`pnpm-lock.yaml` +9159 行。换来的是不自实现协议层。

## F2 零工具叠加（sdk profile）

- [x] 新增 `assets/frontdesk.sdk.patch.yml`：persona + 全部 `tool-*` + `plan-mode`
- [x] 真机发现 `plan-mode` 单独注册了 `exit_plan_mode`（不是 `tool-*` 命名），补上
- [x] 修既有漏洞：`headless` 叠加里删掉 rc.2 已不存在的 `tool-agent-team`，补 `tool-subagent-control` / `tool-subagent-list-agents`
- [x] 真机 `request/header` 复核：`tools` 为空数组

## F3 常驻 runtime

- [x] `src/sdk-runner.ts`：`ResidentTurn` / `createDshSdkTurn` / `createSdkDecisionRunner`
- [x] 串行化（`tail` 链）、超时（默认 60s）、`warm()`、`close()`
- [x] **失败即丢弃**：超时/报错 → `close()` 子进程 → 错误外抛 → 下一轮重新 `createTurn()`
- [x] `src/runner-factory.ts`：`createDecisionRunner({ kind })`，默认 `sdk`，`headless` 保留为逃生口
- [x] `index.ts` 导出

> 踩坑：`withTimeout` 里给定时器加 `unref()` 会让「只有这个定时器在等」的进程直接排空事件循环，
> 超时**永不触发**（测试表现为顶层 await 悬挂）。已去掉 `unref`。

## F4 接线

- [x] `scripts/dev-web.mjs` / `scripts/e2e-smoke.mjs`：改用 `createDecisionRunner`，启动时 `warm()`，退出时 `close()`
- [x] 环境开关：`DSH_WFXM_DECIDE_RUNNER=sdk|headless`、`DSH_WFXM_DECIDE_TIMEOUT_MS`

## F5 验证

- [x] `verify-orchestrator` 30 → **39 例**：常驻 7（复用/串行/超时丢弃/失败丢弃/空决策/关闭后拒绝/工厂默认与拒绝未知）
      + 资产 2（sdk 叠加含 `plan-mode`；**真跑 `--dump-config`** 断言两个 profile 都不剩启用的 `tool-*`，白名单仅 `tool-result-pruner`）
- [x] `verify-svcops-tools` 既有红例修好：`apply` 早已改 `ctx.effect`（cordis 无 `dispose` 事件），测试仍在断言旧模式
      → 改为断言 effect 注册与 disposer 可调用，**25 passed**

真机 A/B（同一句话「你好」，dev-web + stub executor，同机）：

```
headless（每轮冷启动）  #1 2.74s   #2 2.76s
常驻 sdk（一次装配）    #1 1.00s   #2 1.35s     启动预热 1.17s（只付一次）
只读「看看磁盘占用」    20ms（切片 E 直答，不进模型）
```

结论：模型轮次约 **2.7×** 提速；只读问题仍走毫秒级直答。

- [x] 全仓回归：

| 套件 | 结果 |
|---|---|
| host | 19 ✅ |
| tasks | 90 ✅ |
| gateway | 100 ✅ |
| executor | 17 ✅ |
| snapshot | 18 ✅ |
| feishu | 31 ✅ |
| orchestrator | 39 ✅ |
| svcops | 14 ✅ |
| svcops-tools | 25 ✅ |
| svcops-inspection | 27 ✅ |
| svcops-alerting / report / config / docker | 8 / 10 / 14 / 12 ✅ |
| redact / knowledge | ✅ |
| governance（approvals/audit/concurrency/grants/grants-admin/policy/preimages） | 19 / ✅ / 8 / 27 / 20 / 10 / 13 ✅ |
| notify | 16 ✅ |
| invariants（AR32/AR33） | OK ✅ |

## F6 未做（本片边界）

- **取消**：dsh 运行时不支持中断已发出的轮次；「停止」只能等超时后丢弃
- **缓存命中度量**：事件里没有 usage 字段，只能保证前缀稳定，无法报命中率
- **会话轮换**：历史单会话增长，靠 profile 自带压缩，本片不另做
- **reasoning effort**：实测无收益，不动
- **工具面回连**：仍为空，`task_submit`/`say` 还是宿主代码路径

---

# Slice G — 飞书卡片回调与审批按钮（互动面）

> 目标见 `spec.md` Slice G。无数据库迁移；卡片只是视图，正本在 ③ `approvals`。

## G1 ③ 正本补齐

- [x] `plugins/governance/src/approval/store.ts` 增 `setExternalMsgId(approvalId, externalMsgId): boolean`（幂等；未知 id 返回 false，不抛）
- [x] `plugins/governance/src/index.ts` 导出 `createApprovalStore` 与 `ApprovalStore` / `ApprovalRecord` / `ApprovalTicket` / `AnswerCode` 等类型
- [x] `verify-approvals.mjs` 增 P1：create → setExternalMsgId → get 读到 → 再设一次仍成功 → 未知 id 返回 false

## G2 ① 网关：审批应答接线

- [x] 新增 `plugins/gateway/src/approval.ts`：`parseCardAction`（snake/camel、approve|approved、reject|rejected、details）、`ApprovalAnswerPort`、`ApprovalAnswerReport`、`ApprovalAnswerOutcome`
- [x] `ingest.ts`：`IngestDeps.approval?`；`approval_answer` 分支调用端口；`ok → done` / `!ok → failed(code)`；`details`/非法 → `ignore` + `done`；无端口 → `failed('approval-unavailable')` + `result.error`
- [x] `IngestResult` 增 `approval?: ApprovalAnswerOutcome | null`；`error` 联合加 `'approval-unavailable'`
- [x] `plugins/gateway/src/index.ts` 导出
- [x] `verify-gateway.mjs`：旧「card_action → triaged」断言改为 `failed('approval-unavailable')`；新增审批 1–4（ok / nonce-invalid / 无端口 / 非决策动作）

## G3 飞书：卡片入站

- [x] `normalize.ts` 增 `NormalizedCardAction`（`kind:'card_action'`, `channelId`, `msgId=event_id`, `externalUserId=operator.open_id`, `chatId=context.open_chat_id`, `externalMsgId=context.open_message_id`, `replyToMsgId=open_message_id`, `action`）
- [x] `normalizeFeishuCardActionEvent`：支持 `{header, event}` 与扁平两种 envelope；字段缺失返回 null
- [x] `channel.ts`：`onCardAction?`；`register` 同时挂 `im.message.receive_v1` 与 `card.action.trigger`；无 sink 时 `warn` 且只挂消息事件
- [x] `verify-feishu` 卡片 1/2

## G4 飞书：卡片出站与 patch

- [x] 新增 `plugins/feishu/src/card.ts`：`buildApprovalCard`（header 等级 + 摘要 + 影响 + 有效期 + 批准/拒绝按钮，value 含 `approval_id`/`decision`/`nonce`/`channel_id`）、`buildApprovalResultCard`（绿/红 + 已批准/已拒绝）、载荷守卫
- [x] `transport.ts`：`approval_card` → `msg_type:'interactive'`；`approval_result` → `patch({path:{message_id}, data:{content}})`；`patch` 缺失/抛错 → 回退文本
- [x] `index.ts` / `plugin.ts` 导出与透传
- [x] `verify-feishu` 卡片 3–6（渲染内容、interactive 发送、patch 调用、patch 失败回退、无 text 仍拒绝）

## G5 host 组合

- [x] `ports.ts`：`approvals?` 依赖 + `approvalAnswer` 端口（缺 ③ 时 `{ok:false, code:'no-approval-store'}`）
- [x] `host.ts`：`WfxmHostOptions.approvals?`；`requestApproval({level, summary, impact, threadId, chatId?, taskId?, correlationId?, ttlMs?})` → ③ create + ① `enqueueOutbox(topic='approval.card', payload.kind='approval_card', dedupeKey='approval-card:<id>')`；未注入 ③ 抛错
- [x] `host.ingest`：把 `approvalAnswer` 传给 `ingestInbound`
- [x] `onSent`：`topic==='approval.card'` → ③ `setExternalMsgId`
- [x] 决策成功（`result.approval.ok`）→ 入队 `approval.update`（`payload.kind='approval_result'`，带 `externalMsgId`/`text`，`dedupeKey='approval-update:<id>'`）
- [x] `index.ts` 导出 `RequestApprovalInput` / `RequestApprovalResult`
- [x] `verify-host` 审批 1–3（同批修掉 `schema_migrations` PK 漂移：gateway 迁移改 `DELETE`+`INSERT`）

## G6 回归与文档

- [x] `node scripts/check-invariants.mjs`（AR32/AR33）
- [x] `pnpm -r typecheck`（逐包 `tsc --noEmit` 全绿：gateway/governance/tasks/knowledge/host/feishu/snapshot/orchestrator；`pnpm -r typecheck` 本身受既有 lockfile 漂移 + gateway↔tasks cycle 阻塞，非本片引入）
- [x] 全仓回归：host / tasks / gateway / executor / snapshot / feishu / orchestrator / svcops* / redact / knowledge / governance / notify
- [x] `docs/14` §九 #4 状态更新；`AGENTS.md §4` 加本片条目
- [x] 真实冒烟（已跑通，2026-11-11）：`scripts/e2e-smoke.mjs --approval` 发卡 → owner 点「批准」→ `card:result` `ok:true/status=approved`、`approval.update` `sent`、回读飞书 API 该卡标题=`已批准`（`msg_type=interactive`、`需要确认` 消失）。同批修复：`card.action.trigger` 回调必须返回 `{toast}`，否则飞书客户端报「操作失败」。

## G7 未做（本片边界）

- **R2/R3 自动审批闸**：worker 何时请求审批、审批通过后如何重新入队（需 ⑤ 新状态边与事件），下一片
- **「看详情」按钮**：需要卡片回调响应能力，v1.1
- **卡片签名/验签**：长连接下由 SDK 处理；本仓只信任 `app_id` + 已绑定 `open_id`
- **按钮级角色授权**：谁能批 R3 仍由 ③ 正本演进，不在渠道侧

---

# Slice H — 部署与运行（16 SSOT）

> 目标：把「dev 脚本能跑」变成「能长期稳定运行的常驻服务」——生产入口、systemd 非 root + polkit、
> 八步自检、蓝绿发布/回滚、备份/还原演练。**每步真实跑通才算完成**。

## H1 启动序列库

- [x] 新增 `scripts/lib/startup.mjs`：`EXIT_STARTUP_FAILED=1` / `EXIT_ALREADY_RUNNING=3`、`StartupError(step, stepName, message)`、`AlreadyRunningError`
- [x] `parseServeConfig()`：纯 env（无 yaml）；`dataDir`(默认 `/var/lib/dsh-wfxm`) / `dbPath` / `workdir` / `snapshotDir` / `readinessPath` / `lockPath` / `channel`(feishu|loopback) / `foreground`(orchestrator|rule) / `decideRunner`(sdk|headless) / `dshBin` / 凭据路径 / 各超时
- [x] `acquireInstanceLock()`：`O_EXCL` 原子创建 `serve.lock` + pid 存活判定 + 陈旧锁回收；活锁 → `AlreadyRunningError`
- [x] `runStartup(plan, { logger, total })`：按 `step.id` 记 `[startup] N/8 <step>`；失败抛 `StartupError`
- [x] `assertModules()`（第 3 步）/ `assertZeroToolAsset()`（第 4 步）/ `writeReadiness()` / `removeReadiness()`（best-effort）/ `isProcessAlive()`
- [x] `REQUIRED_MODULES` 只列 serve 直接导入的 8 个 API（不伪造 `createGatewayStore` / `createTaskStore`）

## H2 生产入口 `scripts/serve.mjs`

- [x] 头部 `delete process.env.LD_LIBRARY_PATH`；`--check` 走完八步后 `shutdown(0)`
- [x] 装配：六个 store（同 `dbPath`）+ `createSnapshotPort` + `createProjectLookupPort` + `createDshExecutor` + `createWfxmHost`
- [x] `foregroundFactory`：`rule` → `createRuleForeground`；否则 `createDecisionRunner` + `warm()` + `createOrchestratorForeground`（真实探针 `createResourceProbe`）
- [x] 八步 plan（id 2..8）：配置后开库/integrity → 模块 → 零工具资产 → 端口探活（可执行/可写/凭据存在）→ `host.worker.recover()` → 渠道（loopback / 真实飞书 + 无绑定打印 `/bind`）→ readiness
- [x] `onMessage` → `host.ingest` + `pump()`；`onCardAction` → ingest + pump + 返回 `{ok, toast}`
- [x] `shutdown(code)`：`host.stop()` → 最多 3 轮 pump flush → `channel.stop()` → `decideRunner.close()` → `host.close()` + stores close → `removeReadiness` → `lock.release()` → exit
- [x] `SIGTERM`/`SIGINT` 处理；`setInterval(()=>{}, 60_000)` 保活（否则无活动句柄时静默退出）

## H3 systemd 与 polkit

- [x] `deploy/systemd/dsh-wfxm.service`：非 root、`EnvironmentFile`、`HOME` 重定向、`Restart=on-failure` + `StartLimit`、`TimeoutStopSec`、`UMask`、加固项、`ReadWritePaths`；**无 `ExecReload`**
- [x] `deploy/systemd/dsh-wfxm.env.example`：非敏感项 + 凭据路径（`/etc/dsh-wfxm/credentials/...`）
- [x] `deploy/polkit/50-dshwfxm.rules`：只放行 `dshwfxm` 对 `dsh-wfxm-managed-*` unit 的 `manage-units`
- [x] `scripts/verify-deploy.mjs` **5 例**：unit 必需指令、ExecStart/EnvironmentFile/WorkingDirectory、env 模板一致且无密钥、`systemd-analyze verify`（路径替换到本机）、polkit 规则 stub 五分支

## H4 蓝绿发布与回滚

- [x] `scripts/release.mjs`：`prepare` / `verify` / `switch` / `rollback` / `list` / `current` / `gc`；`root` 一律 `resolve()`
- [x] `prepare`：`EXCLUDES`（node_modules/.git/.wfxm/releases/current/coverage）+ `REQUIRED` 清单 + `cpSync(dereference:false)` + `linkDependencies`（`cp -a --link`，失败回退复制）+ `release.json`
- [x] `verify`：跑 **release 自己的** `scripts/serve.mjs --check`，并断言 `@dsh-wfxm/gateway` realpath 在该 release 内
- [x] `switch`：校验 REQUIRED → tmp symlink + rename（原子）；不完整拒绝；`gc` 永不删 `current`
- [x] `scripts/verify-release.mjs` **7 例**：prepare/verify/自包含/switch/list、v2→rollback→v1 且 N-1 可 verify、坏版本双拒、重复/不存在版本拒绝、gc 保留 current

## H5 备份与还原演练

- [x] `scripts/backup.mjs`：`VACUUM INTO`（只读连接）+ `PRAGMA integrity_check` + 拷 `memory/snapshots/outbox-files`（+ config）+ `manifest.json`（tag/counts/components）+ `tar -czf` + `.sha256`；restic 可选、未配打印 `skipped`；无 `ops.sqlite` 显式失败
- [x] `scripts/restore-drill.mjs`：sha256 校验 → 解包 → manifest → `integrity_check` + 逐表行数比对 + components 存在 → 用 `serve.mjs --check`（`DATA_DIR=target`、loopback、rule）断言 `[startup] 8/8`；默认临时目录用完即删（同批修：`fail()` 去掉临时目录再退出，`process.exit` 会跳过 `finally` 导致拒绝路径泄漏 `/tmp/wfxm-restore-*`）
- [x] `scripts/verify-backup.mjs` **6 例**：种子（serve + 真实 store 写 + snapshots 文件）→ 产物/sha256/counts/restic skipped → 还原 8/8 + 组件还原 → 篡改 hash 拒 → 缺 manifest 拒 → 行数不符拒 → 空数据目录拒

## H6 回归、文档与清理

- [x] `package.json` 增 `serve` / `serve:check` / `verify:serve` / `verify:deploy` / `verify:release` / `verify:backup` / `release` / `backup` / `restore:drill`
- [x] 全仓回归 29 套件全绿（serve 12 / deploy 5 / release 7 / backup 6 + 既有 25 套）
- [x] `node scripts/check-invariants.mjs` OK（AR32/AR33）；逐包 `tsc -p plugins/<pkg>/tsconfig.json --noEmit` 12/12
- [x] `docs/16` 回写：§一 目录布局、§三 unit/polkit 指向实际文件、§四 八步与退出码、§五 单实例、§六 发布/回滚、§七 备份实现、§十一 验收（本机/待服务器）、§十二 落地对照与未做
- [x] `AGENTS.md §4` 加 Slice H 条目
- [x] 清理验证残留（`.wfxm/serve-check`、`.wfxm/releases-test`、`/tmp/wfxm-*`）
- [x] **真实长跑冒烟（2026-11-11）**：`serve` 以 `DSH_WFXM_CHANNEL=feishu` 启八步全过（channel 1093ms）→ `/bind` 配对成功（`bypass='pairing'`）→
      owner 发「看看磁盘占用」→ `task-created` → ack 真实送达（`om_x100b607474da84a0dd33363f400ab40`）→ 真实 `dsh` 执行 `du -xsh /` 78s →
      `succeeded` + 回执真实送达（`om_x100b607408432cb0ddea8ee23a35876`，`delivered_at` 已回填）→ 连续 ~16 分钟无 warn/error →
      `SIGTERM` 后 readiness 与 `serve.lock` 均清理、退出码 0。记录见 `docs/16 §12.4`

## H7 未做（本片边界）

- **systemd 实际安装**：创建 `dshwfxm` 用户、装 unit、`daemon-reload`、`enable --now` 需 root
  - [x] `deploy/install.sh`（幂等；非 root 可用 `DRY_RUN=1` 预览；`bash -n` + dry-run 已跑）
  - [ ] 在目标机 `sudo bash deploy/install.sh` —— **待 owner 执行**（开发用户 `ailearn` 在 `sudo` 组但非交互 sudo 需密码）
- ~~**真实 `serve` 飞书长连接与消息闭环**~~ → **已跑通（2026-11-11，见 H6 末项）**
- **蓝绿自动回滚**：只做手动 `release rollback`，不做"自检失败自动切回"
- **docker socket proxy / metrics·OTel / journald 配置 / 备份自动轮转**：均未做
- **迁移失败自动恢复**：不做，靠备份 + 人工

---

# Slice I — 审批闸：R2/R3 执行前必须先确认

> 依赖 `spec.md` 的 Slice I 段。每项独立可中止；**没跑的测试不算绿**。
> 无数据库迁移：`tasks.status` 已允许 `waiting_approval`。

## I1 ⑤ 受控状态操作

- [x] `plugins/tasks/src/store.ts`：`holdTaskRow`（`queued → waiting_approval`，条件更新）与 `resumeFromApprovalRow`（`waiting_approval → queued`，清租约、`next_attempt_at = now`）
- [x] `holdForApproval({ taskId, reason? })`：不存在 → `not-found`；非 `queued` → `conflict`；写 `task.waiting_approval` 事件
- [x] `resumeFromApproval({ taskId, approvalId, actorId?, now? })` → `{ resumed, task, reason?: 'not-found' | 'not-waiting' }`；不因状态不对抛错；写 `task.resumed` 事件
- [x] `TaskStore` 接口 + 类型导出（`ResumeFromApprovalResult`）
- [x] `plugins/tasks/src/model.ts` 注释：resume 是与 `wakeTask` 同例的受控例外，不进 `ALLOWED_TRANSITIONS`

## I2 host 风险闸

- [x] `plugins/host/src/host.ts` `ingest()` 的 `task-created` 分支：R2/R3 → `holdForApproval` + `requestApproval`（level 由 riskLevel 直接映射，`chatId/channelId` 取自 `result.thread`）
- [x] ack 文案：R2/R3 → 「需要确认，卡片已发」；R0/R1 不变
- [x] `approvals === null` 或无 thread → fail-closed 取消 + 可见说明（AR13），绝不执行

## I3 审批结果唤醒

- [x] `plugins/gateway/src/approval.ts`：`ApprovalAnswerReport` 增 `taskId?` / `taskStatus?`
- [x] `plugins/host/src/ports.ts` `approvalAnswer.answer`：成功后重读 ③ 正本取 `taskId`；`approved` → `resumeFromApproval`；`rejected` → `transition(paused)`；`ok:false` 不碰任务
- [x] `plugins/host/src/host.ts` patch 文案：`已批准，任务继续执行` / `已拒绝，任务已暂停`

## I4 验证

- [x] `verify-tasks.mjs`：hold 生效 + 事件 / hold 非 queued 抛 conflict / worker 不领 `waiting_approval` / resume 后可领取 / 二次 resume `resumed:false` / 未知任务 `not-found`
- [x] `verify-host.mjs`：R2 建任务 → `waiting_approval` + 卡片 + ack / 批准 → 执行成功 + 回执 / 拒绝 → `paused` 不执行 / 二次点击不重复恢复 / R1 不受影响 / 无 ③ 时 fail-closed
- [x] 回归：`verify-tasks`、`verify-host`、`verify-serve`、`check-invariants`、逐包 `tsc --noEmit`

## I5 文档

- [x] `AGENTS.md §4` Slice I 条目
- [x] `docs/16` §十二（或部署边界）补「审批不可用 = 拒绝执行」；`spec.md` Slice I 标记已实施

## I6 未做（本片边界）

- R3 二次确认（强确认）、「看详情」按钮、按钮级角色授权
- `tools.start/resume` 直接把任务置 `running` 却不带租约的既有怪异
- 被拒任务自动取消（本片按状态机留在 `paused`）

## I7 验证记录（2026-11-11，全部真跑）

| 套件 | 结果 |
|---|---|
| `verify-tasks` | **94 passed, 0 failed**（新增 4 例：hold/冲突/worker 不领/二次恢复幂等） |
| `verify-host` | **28 passed, 0 failed**（新增 6 例：审批 4–9） |
| `verify-gateway` | **104 passed, 0 failed** |
| `verify-serve` | **12 / 12** |
| `check-invariants` | OK（AR32/AR33） |
| `tsc --noEmit` | tasks / gateway / host 全绿 |

实现中两处必要修正：

1. ① 的 `approval_answer` 分支原先手工拼 `ApprovalAnswerOutcome`，会把端口层新加的 `taskId/taskStatus` 丢掉 → 已改为原样透传。
2. `HostPortDeps` 增 `now`，让 `resumeFromApproval` 的 `next_attempt_at` 与 worker 共用同一时钟（否则测试钉死的时钟会让恢复后的任务"未来才可领"）。

---

# 接续作业：部署收尾（root 会话，2026-11-11）——✅ 已执行完成

> **2026-11-11 已按 R1–R6 上机完成**，release `2026.11.11-1` 在 `192.168.16.58` 上
> `enabled + active`。执行结果见本节目录末尾「5. 执行记录」；两个真机缺口（Landlock
> syscall 被过滤、profile 软链在服务 HOME 失效）已修复并回写 `docs/16 §三 / §12.6`。
> 下面的命令序列保留作复现手册。

## 0. 当前事实（2026-11-11 复核，勿凭记忆改）

| 项 | 事实 |
|---|---|
| 目标机 | `192.168.16.58` **就是本机**（`ens18`）；仓库 `/home/ailearn/projects/dsh-wfxm` |
| root SSH | 已可用：`sshd_config` 有 `PermitRootLogin yes` + `PasswordAuthentication yes`，owner 已重置 root 密码 |
| 开发用户 | `ailearn`（uid=1001，在 `sudo` 与 `docker` 组）；**`sudo -n` 失败**（需交互密码），所以任何 root 操作必须换 root 会话 |
| 系统 Node | **`/usr/bin/node` 不存在**；Node 24.11.0 与 `dsh` 只在 `/home/ailearn/.nvm/versions/node/v24.11.0/bin/` |
| 服务用户/目录 | `dshwfxm` 用户、`/opt/dsh-wfxm`、`/etc/dsh-wfxm`、`/var/lib/dsh-wfxm` **均不存在**（待 `deploy/install.sh` 创建） |
| 凭据 | `/home/ailearn/.dsh/.credentials.yaml`（0600，314B）、`/home/ailearn/.dsh/integrations/dsh-feishu/config.json`（0600，996B） |
| dsh profiles | `/home/ailearn/.dsh/profiles/{headless,sdk,web}` 已存在；服务用户的 `HOME=/var/lib/dsh-wfxm/home` 是空的 |
| 生产库 | `/var/lib/dsh-wfxm/ops.sqlite` 不存在（全新），**上线后需重新 `/bind` 配对** |
| 仓库状态 | 有**大量未提交改动**（docs/插件/配置）。**不要 `git reset`/`git checkout`/`git clean`；不要 commit，除非 owner 明确要求** |
| 依赖形态 | `plugins/*/node_modules` 与根 `node_modules/@dsh-wfxm` 是**手建软链**；**绝不跑 `pnpm install`、不动 `pnpm-lock.yaml`** |

## 1. 环境约束（每个新 shell 第一件事）

```bash
unset LD_LIBRARY_PATH     # Trae 注入的旧 libstdc++ 会让 better-sqlite3 崩
```

- root 会话里**构建/发布/跑脚本一律用 ailearn 身份**（`sudo -u ailearn -H`），否则仓库与 release 目录会被 root 属主污染，后续开发写不进去。
- 如果 root 会话里用编辑器改了仓内文件，收尾时 `chown -R ailearn:ailearn /home/ailearn/projects/dsh-wfxm`，别留下 root 属主的源码。
- 任何 node/tsc 命令都先 `unset LD_LIBRARY_PATH`；`/usr/bin/node` 在 R1 之后才存在。

## 2. 命令序列（R1 → R6，全部在仓库根执行）

### R1 主机侧安装（root；幂等，可重复跑）

```bash
cd /home/ailearn/projects/dsh-wfxm

# 先干跑看一眼将执行什么（可选）
DRY_RUN=1 NODE_SRC=/home/ailearn/.nvm/versions/node/v24.11.0 RELEASE_OWNER=ailearn \
  bash deploy/install.sh

# 真正安装
NODE_SRC=/home/ailearn/.nvm/versions/node/v24.11.0 RELEASE_OWNER=ailearn \
  bash deploy/install.sh
```

做四件事：① 复制 Node 24 到 `/usr/local/lib/nodejs/v24.11.0` 并软链 `/usr/bin/node`、`/usr/local/bin/dsh`；
② 建 `dshwfxm` 系统用户（nologin、**不加 docker 组**）与四个目录，按 unit 的 `ReadWritePaths` 收权限；
③ 只在缺失时生成 `/etc/dsh-wfxm/env`（`root:dshwfxm 0640`，不覆盖已有）；
④ 装 unit + polkit 规则并 `daemon-reload`；最后建 `/opt/dsh-wfxm`（属主 `RELEASE_OWNER`）。

> **`RELEASE_OWNER=ailearn` 不能省**：root SSH 下 `SUDO_USER` 为空，默认会变成 root，
> 之后 `release.mjs` 以 ailearn 身份写 `/opt/dsh-wfxm` 会 Permission denied。

### R2 安装校验

```bash
id dshwfxm
getent group dshwfxm
/usr/bin/node -v                       # 期望 v24.11.0
env -u LD_LIBRARY_PATH HOME=/tmp/dsh-check /usr/local/bin/dsh --version
ls -ld /opt/dsh-wfxm /etc/dsh-wfxm /etc/dsh-wfxm/credentials /var/lib/dsh-wfxm /var/lib/dsh-wfxm/home
```

### R3 发布（以 ailearn 身份）

```bash
cd /home/ailearn/projects/dsh-wfxm
for step in prepare verify switch; do
  sudo -u ailearn -H env -u LD_LIBRARY_PATH \
    /usr/bin/node scripts/release.mjs "$step" --version 2026.11.11-1 || break
done
sudo -u ailearn -H env -u LD_LIBRARY_PATH /usr/bin/node scripts/release.mjs current
```

- `verify` 跑 **release 自己的** `serve.mjs --check`（八步全过才算发布成功），并断言 gateway realpath 在该 release 内。
- 版本号任意合法串（`^[A-Za-z0-9][A-Za-z0-9._-]*$`），变更后换新号；`switch` 只换软链，**不重启服务**。
- 失败就停：`prepare` 失败查 node_modules 硬链/磁盘；`verify` 失败看它打印的 `[startup] N/8` 是哪一步。

### R4 凭据（root 拷入，属主 `root:dshwfxm` 0640）

```bash
install -m 0640 -o root -g dshwfxm \
  /home/ailearn/.dsh/integrations/dsh-feishu/config.json \
  /etc/dsh-wfxm/credentials/feishu.json
install -m 0640 -o root -g dshwfxm \
  /home/ailearn/.dsh/.credentials.yaml \
  /etc/dsh-wfxm/credentials/credentials.yaml
```

> `ProtectHome=yes` 让服务看不到 `/home/ailearn`，所以必须搬；env 里的
> `DSH_WFXM_FEISHU_CONFIG` / `DSH_WFXM_CREDENTIALS` 已指向这两个路径。

### R4b 服务 HOME 的 dsh 运行面（root）

启动能过八步，但任务执行时 dsh 还需要 `$HOME/.dsh` 下的 profiles 与模型凭据：

```bash
install -d -o dshwfxm -g dshwfxm -m 0700 /var/lib/dsh-wfxm/home/.dsh
cp -a /home/ailearn/.dsh/profiles /var/lib/dsh-wfxm/home/.dsh/
install -m 0600 -o dshwfxm -g dshwfxm \
  /home/ailearn/.dsh/.credentials.yaml /var/lib/dsh-wfxm/home/.dsh/.credentials.yaml

# 关键：相对软链在服务 HOME 下会解析到 /var/lib/dsh-wfxm/projects/...（不存在）
P=/var/lib/dsh-wfxm/home/.dsh/profiles/headless/node_modules/@dsh-wfxm
rm -f "$P/governance" "$P/svcops"
ln -s /opt/dsh-wfxm/current/plugins/governance "$P/governance"
ln -s /opt/dsh-wfxm/current/plugins/svcops "$P/svcops"
chown -h dshwfxm:dshwfxm "$P/governance" "$P/svcops"
```

### R5 启动

```bash
systemctl enable --now dsh-wfxm
systemctl status dsh-wfxm --no-pager
journalctl -u dsh-wfxm -n 120 --no-pager
```

期望：`[startup] 1/8 … 8/8` 全过 → 无绑定 → 日志打印 `/bind XXXX-XXXX`（5 分钟 TTL）→ `readiness` 落盘。

### R6 配对与真机冒烟（owner 在飞书操作）

1. owner 给机器人发 `/bind XXXX-XXXX` → 日志出现 `bypass='pairing'`、`channel_bindings=1`。
2. 发「看看磁盘占用」→ 期望 **20ms 级直答**（切片 E，不建任务）。
3. 发一条 R1 任务（如「把 /tmp 下 3 天前的空目录列出来」）→ 期望 `task-created` → `succeeded` → 回执送达。
4. 检查：

```bash
journalctl -u dsh-wfxm -f                      # 看 in / route / foreground / execution
cat /var/lib/dsh-wfxm/readiness                # pid + 版本 + 时间
systemctl show dsh-wfxm -p MainPID,ActiveState
```

5. 停止/重启语义：`systemctl stop dsh-wfxm` 应 `SIGTERM` → 退出码 0 → `readiness` 与 `serve.lock` 被清理。

> 2026-11-11 实测：1–3 的链路都通（绑定落库、直答回执、任务 `succeeded` + 回执），
> 但任务体报 `SANDBOX_UNAVAILABLE`；根因与修法见下方风险表与 `docs/16 §12.6`。

## 3. 已知风险与处置

| 风险 | 处置 |
|---|---|
| `ExecStart=/usr/bin/node` 不存在 | R1 没跑或 `NODE_SRC` 指错；重跑 R1，确认 `NODE_SRC/bin/node` 可执行 |
| 服务起不来、日志说 profile/凭据找不到 | 按 R4b 铺 `$HOME/.dsh`（profiles + `.credentials.yaml` + 改写 `@dsh-wfxm/*` 软链），再 restart |
| 任务执行报 `SANDBOX_UNAVAILABLE` | unit 的 `SystemCallFilter=@system-service` 早于 Landlock，`landlock_*` 被 EPERM；bwrap 又被空 `CapabilityBoundingSet` 废掉。已在 unit 追加三个 Landlock syscall（`landlock_create_ruleset landlock_add_rule landlock_restrict_self`），`daemon-reload` + restart 生效 |
| dsh 日志出现 `skipping profile bundle @dsh-wfxm/*` | profile 里是指向仓库的相对软链，服务 HOME 下解析到 `/var/lib/dsh-wfxm/projects/...`；按 R4b 改成指向 `/opt/dsh-wfxm/current/plugins/*` |
| 反复失败后 `start request repeated too quickly` | `systemctl reset-failed dsh-wfxm` 再 start（`StartLimitBurst=5/300s`） |
| ailearn 写不了 `/opt/dsh-wfxm` | R1 漏了 `RELEASE_OWNER=ailearn`；`chown -R ailearn:ailearn /opt/dsh-wfxm` 后重跑 R3 |
| 审批闸在真机不触发 | **预期行为**：orchestrator 的 `parseDecision` 拒绝 R2/R3，生产前台不会自然产生 R2/R3 任务。审批闸目前是纵深防御，验证靠 `verify-host`（审批 4–9） |
| 想回滚 | `release rollback`（以 ailearn）+ `systemctl restart dsh-wfxm`；N-1 永远可 verify |
| 忘记 unset LD_LIBRARY_PATH | 症状是 better-sqlite3 报 `GLIBCXX_... not found`；重开 shell 或 `unset LD_LIBRARY_PATH` 重跑 |

## 4. 收尾（部署成功后回写，不是前置）

- [x] R1 完成 → `dshwfxm` uid 997；`/usr/bin/node` v24.11.0；`dsh` 0.2.1-rc.2。
- [x] R3 完成 → release `2026.11.11-1`（commit `cdcd7f0`）；`release current` 指向它，属主 ailearn。
- [x] R6 完成 → journal 关键行与 `om_` id 已写进 `docs/16 §12.6`（生产 systemd 真机冒烟）。
- [x] `docs/16 §12.3` 的「systemd 实际安装」「真实飞书 serve 长连接」两行状态改为已跑通，并补「服务 HOME 运行面」。
- [x] `AGENTS.md §4` 的「部署接续」条目改为「已上线」，并写明当前 release 版本。
- [x] `deploy/install.sh` 补 `/etc/polkit-1/rules.d` 目录；unit 补 Landlock syscall、`Documentation` 改 ASCII 路径。

## 5. 执行记录（2026-11-11，root 会话）

| 项 | 结果 |
|---|---|
| R1 | `dshwfxm` uid 997；目录 `/opt/dsh-wfxm`(ailearn)、`/etc/dsh-wfxm`(root:dshwfxm)、`/var/lib/dsh-wfxm`(dshwfxm)；unit/polkit 已装 |
| R2 | `/usr/bin/node` v24.11.0；`dsh` 0.2.1-rc.2 |
| R3 | `prepare → verify(8/8) → switch`，release `2026.11.11-1` |
| R4 | `/etc/dsh-wfxm/credentials/{feishu.json,credentials.yaml}`，`root:dshwfxm 0640` |
| R4b | `/var/lib/dsh-wfxm/home/.dsh` 已铺 profiles + `.credentials.yaml`；`@dsh-wfxm/*` 指向 `/opt/dsh-wfxm/current/plugins/*` |
| R5 | `enabled + active`；`[startup] 8/8`；`front:warm sdk` 完成；`readiness` 落盘 |
| R6 | `/bind` 成功（`bound_at=08:33:58Z`）；直答回执 `om_x100b6076c53ef8a4c0a85267f2ab317`；任务 `b9dqbdzkxn` `succeeded`，回执 `om_x100b6076c192a490df1f658ab01fd70`（任务体因沙箱不可用未执行） |
| 停止语义 | `systemctl stop` → `ExecMainStatus=0`；`readiness`/`serve.lock` 清理 |
| 沙箱复验 | 同 unit 硬化参数下真实 `dsh --profile headless` 跑 bash → `profile-bundles-ok`，`landlock-run: partial enforcement`，无 `SANDBOX_UNAVAILABLE` / `skipping profile bundle` |

> 入站事件只能由真实飞书用户触发（网关丢弃 `sender_type='app'`），这部分无法脚本代劳；
> 修复后的飞书侧未再补发任务，因为入站链路由上表已证实，执行侧已在同硬化环境复验。

---

# Slice J — 定时巡检 + 日报（2026-11-11 已上线）

> 目标：把「手动 `svc_inspect` / `svc_report`」变成**宿主主动跑**——按间隔巡检、按打扰分级推送、每天一份日报。
> 边界：只发现 + 报告；修复仍走 C6 + R3 确认。

## J1 调度器（`plugins/svcops/src/patrol.ts`）

- `readPatrolConfig(env, fallbackTarget)` → `{config:{intervalMinutes,digestHour,target}, warnings}`；非法值回落默认并告警，
  `0` 关闭巡检、`-1` 关闭日报，默认 `15` 分钟 / `09:00`。
- `createInspectionPatrol({collect, store, grade, deliver, logger, now, ...})` → `{start, stop, runOnce}`：
  - `runOnce`：采集 → `store.save` → `gradeInspection`；
    - `immediate`：按失败项组合 `key=patrol-alert:<target>:<failedIds>` 做 30 分钟静默；
    - 到点日报：`summarize(store.listSince(from,to))`，`dedupeKey=patrol-digest:<target>:<YYYY-MM-DD>`。
  - `deliver` 抛错只 `logger.warn`，不影响服务与后续轮次。
  - `start()` 15s 首跑 + `setInterval`（`unref()`）；`stop()` 清定时器并关 store。
- `formatInspectionAlert` / `formatInspectionDigest`：中文文案；空窗口输出「窗口内没有巡检记录」。

## J2 接线（`scripts/serve.mjs`）

- `host.start()` 后 `startPatrol()`：读 `readPatrolConfig` + `readInspectionConfig`，`collect` 用
  `evaluate(await collectHostMetrics({runner: spawnRunner, expectedPorts, logWindowMinutes}), thresholds, expectedPorts)`。
- `deliver`：从 `host.stores.gateway.listBindings()` 取最新活跃 binding 的 `externalUserId`，
  `enqueueOutbox({topic:'say', payload:{text, openId}, dedupeKey})`；无绑定记 `patrol:warn` 丢弃（不静默假装送达）。
- `shutdown` 中在 `host.close()` **之前** `patrol.stop()`。

## J3 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `DSH_WFXM_PATROL_INTERVAL_MINUTES` | `15` | `0` 关闭巡检 |
| `DSH_WFXM_DIGEST_HOUR` | `9` | `-1` 关闭日报 |
| `DSH_WFXM_PATROL_TARGET` | 主机名 | 巡检目标标识（告警/去重键里用） |
| `DSH_WFXM_AUDIT_DB` | `/var/lib/dsh-wfxm/ops.sqlite` | 宿主与 dsh 子进程共用同一审计/巡检库 |

已同步 `deploy/systemd/dsh-wfxm.env.example` 与生产 `/etc/dsh-wfxm/env`。

## J4 验证

- `scripts/verify-patrol.mjs` **8/8**：默认值；`0`/`-1` 与非法值回落；空日报；`fail` 首推 + 静默 + 31min 后重推（`dedupeKey` 不同）；
  09:00 后日报每日一次；09:00 前不推；投递抛错被隔离；`interval=0` 不装定时器。
- 时间用 `new Date(2026,10,11,10,0,0)` 本地时间构造，测试与时区无关。
- 回归：`verify-serve` 12/12、`check-invariants` OK。

## J5 生产证据（release `2026.11.11-2`）

| 项 | 结果 |
|---|---|
| 服务状态 | `active`；日志 `patrol every 15min, digest 9:00` |
| 首轮巡检 | `patrol cycle ok (pushed digest)`；`inspections` 1 条 `ok` |
| 出站 | `outbox.status=sent`，`external_msg_id=om_x100b60769bd7a0a4de55af1561ea1be` |

## J6 未做（本片边界）

- 静默窗是**进程内状态**；重启后靠 `dedupeKey` 时间桶兜底，不做持久化。
- 日报只覆盖巡检；**任务/会话日报**要读 ① 的 `tasks`/`task_events`，不在本片越权直读。
- 巡检项与阈值可配（`DSH_WFXM_EXPECTED_PORTS` / `DSH_WFXM_INSPECT_THRESHOLDS`），但**不做**自动修复、不做告警升级链路。

# Slice K — R2/R3 审批执行打通（2026-11-11 已上线）

> 目标：卡片批准后**真的能执行**服务操作。切片 I 解决了「未批准不许跑」，本片解决「批准了也跑不了」。
> 边界：批准仍授权**整个任务**；R3 二次确认、按钮级角色授权、看详情不在本片。

## K1 规则层风险升级（`plugins/tasks/src/risk.ts`）

- `planTaskRisk(intent, baseline)`：基线已是 R2/R3 原样返回；基线 R0/R1 且命中**起/重启托管服务**时升到 `R3`，
  并附模板断言 `service_active(unit)`（保证「无判据不 R2+」不变）；其余保持基线。
- `managedUnitFor(intent)` 的识别范围（**只升不降**）：
  - 显式 `dsh-wfxm-managed-<name>.service`，**且**句子里有起/重启动词；
  - 「重启 <name> 服务」/「restart <name> service」→ `dsh-wfxm-managed-<name>.service`。
  - stop / 停止、docker 容器、没有「服务」名词的普通句子**一律不升级**（避免把只读问题误判成 R3）。
- 宿主两条前台（`plugins/host/src/foreground.ts`、`plugins/orchestrator/src/foreground.ts`）创建任务时统一走 `planTaskRisk`，
  写入 `task.riskLevel`、逐条 `addAssertion`，note 记 `risk-escalated:svc-start:<unit>`。

## K2 执行器与工具审批桥

- **`plugins/executor/src/executor.ts`**：spawn 前只对 `R2`/`R3` 注入 `DSH_WFXM_APPROVED_LEVEL=<level>`；`R0`/`R1` **显式删除**，防止父进程环境泄漏。
- **`plugins/governance/src/index.ts`**：`DSH_WFXM_TASK_ID` 与 `DSH_WFXM_APPROVED_LEVEL ∈ {R2,R3}` 同时存在时，注册
  `approval/request` answerer（位于 policy 早退**之前**，policy=null 也生效）；仅 `toolName.startsWith('svc_')` 返回 `'allowed-once'`，
  其余 `next()` 交回原链路（无 answerer 时仍是 `unavailable` fail-closed）。
- **`scripts/serve.mjs`**：worker 注入 `verify.serviceStatus`，用 systemd `activeState` 判定，`service_active` 不再 `skipped`。

## K3 提权路径：polkit → 受控 wrapper + sudoers

- **事实纠正**：`polkitd` 0.105（Ubuntu 22.04）**不解析 JS 规则**（JS backend 自 0.106 起），
  `/etc/polkit-1/rules.d/50-dshwfxm.rules` 写了也无效；现场表现为 `systemctl` 报
  `Interactive authentication required`，且 `polkitd` 日志无任何命中。
- **`deploy/bin/dsh-wfxm-unit-control`**（root:root 0755）：三重校验后 `exec /bin/systemctl`——
  verb ∈ `start|stop|restart`、unit 必须 `dsh-wfxm-managed-*.service`、字符集不含 `..`/非法字符；失败返回 `64`。
  `DSH_WFXM_SYSTEMCTL` 供测试替换可执行文件。
- **`deploy/sudoers/dsh-wfxm-unit-control`**（0440）：唯一一条 `dshwfxm ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wfxm-unit-control *`。
- **`plugins/svcops/src/systemd.ts` + `tools.ts`**：适配器新增 `controlCommand`，写操作走 `[...control, action, unit]`，读操作仍走 `systemctl`；
  `apply()` 读 `DSH_WFXM_UNIT_CONTROL`（空白分隔成 argv），生产值 `sudo -n /usr/local/sbin/dsh-wfxm-unit-control`。
- **`deploy/install.sh`**：安装 wrapper 0755 与 sudoers 0440，sudoers 写前 `visudo -cf` 预检（失败不落盘，避免 sudo 全局不可用）；
  顺带修正 `RELEASE_OWNER` 默认值（`SUDO_USER` 为空时优先 `ailearn`，否则 `/opt/dsh-wfxm` 变 root 属主、release verify `mkdtemp` EACCES）。

## K4 验证

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `verify-risk` | **12/12** | 起/重启升级、stop/容器/普通名词不升级、显式 unit 前缀、断言仅一条 |
| `verify-approval-bridge` | **7/7** | 双 env 才注册；`svc_*` 放行；非 `svc_*` 走 `next()`；R1 不注册 |
| `verify-host` | **29/29** | 审批 10：R3 挂起 → 卡片 → 批准 → 执行 → 断言通过；批准前适配器未被调用 |
| `verify-orchestrator` | **40/40** | 模型提 R1 的「重启 demo 服务」→ note + R3 + `service_active` |
| `verify-executor` | **18/18** | R3 注入 / R1 删除 `DSH_WFXM_APPROVED_LEVEL`（独立 store，避免污染共享队列） |
| `verify-svcops` | **15/15** | 写操作走 `controlCommand`，读操作仍走 `systemctl` |
| `verify-deploy` | **7/7** | wrapper 4 分支（放行/非托管/非起停/`..`）+ sudoers 单行正则 |

回归：tasks 94、svcops-tools 25、inspection 27、approvals 25、policy 10、serve 12、`check-invariants` OK。

## K5 生产证据（release `2026.11.11-4`）

| 项 | 结果 |
|---|---|
| 服务 | `dsh-wfxm` `active`，release `2026.11.11-4`；巡检日志正常 |
| 真机执行 | 以 `dshwfxm` 跑 `dsh --profile headless`，`svc_restart dsh-wfxm-managed-demo.service` 返回 `restart: ... done` |
| 效果 | 演示单元 `ActiveEnterTimestamp` 由 `18:00:15` 变为 `18:01:03`（不是只返回成功文案） |
| 夹具 | `/etc/systemd/system/dsh-wfxm-managed-demo.service`（`/bin/sleep infinity`，`Restart=no`），冒烟后清理 |

## K6 未做（本片边界）

- 批准粒度仍是**整个任务**，不是单条命令；恢复＝重新排队重跑，接不上原 dsh 会话。
- R3 的**二次确认**、「看详情」、按钮级角色授权未做（切片 I 已记录）。
- 只桥接 `svc_*` 工具；其他高风险工具（`mail_send`、`browser_act` 提交）走同样机制前需单独评审。
- polkit 规则文件仍随 install 安装，供 0.106+ 主机使用；本机（0.105）**以 wrapper + sudoers 为准**。

---

# Slice L — R3 二次确认与「看详情」（2026-11-11 已上线）

> 目标：审批卡不再只有「批准/拒绝」。R2/R3 卡可「看详情」（只读回显 intent / 风险 / 判据 / 计划），
> R3 必须**两次点击**才放行——首击只进入确认态，第二击走专用 `confirm` 决策，双击「批准」永不放行。
> 边界：批准粒度仍是整个任务；不做按钮级角色授权；不做签名/验签。

## L1 ③ 审批正本：两段式状态（`plugins/governance/src/approval/store.ts`）

- 迁移 v2（`ALTER TABLE`）：`confirm_stage INTEGER NOT NULL DEFAULT 0` / `confirm_actor TEXT` / `confirm_at TEXT`；
  `migrate()` 改为按 `MIGRATIONS` 顺序逐版推进（v1 建表、v2 加列），旧库与空库走同一条路径。
- `ApprovalDecision` 扩为 `approved | rejected | confirmed`；`AnswerCode` 增 `confirm-required` / `confirm-invalid`；
  `AnswerResult` 增 `stage` 与（仅确认态返回的）`nonce`；`ApprovalRecord` 增 `confirmStage` / `confirmActor` / `confirmAt`。
- `answer()`：R3 的 `approved` 首击只写 `confirm_stage=1`（不决定、不消费 nonce）并返回 `confirm-required`；
  再点 `approved` 仍是 `confirm-required`（双击无效）；只有 `confirmed` 且与首击同一 actor 才落 `approved`。
  R2 收到 `confirmed` → `confirm-invalid`；拒绝（R2/R3）仍是一击；过期/重放/换人路径不变。

## L2 ① 网关：details 分支与确认态

- `plugins/gateway/src/approval.ts`：卡片决策增 `confirm`（载荷 `confirm|confirmed`），answer 入参增 `confirmed`；
  新增 `ApprovalDetailPort` / `ApprovalDetail`（只含展示字段，无 nonce）。
- `plugins/gateway/src/ingest.ts`：`details` 从「忽略」改为**只读分支**——调 `approvalDetails` 端口、写 route decision
  （`read-only`），返回 `result.details`，**不碰 ③、不消费 nonce**；端口缺失 → `approval-unavailable` 但仍 `done`。
  `confirm-required` 视为**预期中间态**：inbox `done`（不是 failed），`approval` 结果带 `stage`/`nonce`。

## L3 宿主：详情端口与两张新卡

- `plugins/host/src/ports.ts`：新增 `approvalDetail` 端口（③ 记录 + ⑤ 任务/断言合成，`tasks.listAssertions`）；
  `approvalAnswer` 对 `confirmed` 与 `approved` 都走 `resumeFromApproval`，拒绝路径不变。
- `plugins/host/src/host.ts`：新 topic `approval.detail` / `approval.confirm`。详情点击 → `approval_detail` 卡（独立消息）；
  `confirm-required` → `approval_confirm` 卡（**patch 原卡**，带同一 nonce）；落定后仍发 `approval_result`。
  详情/确认卡均不影响审批状态；退出/失败时文本兜底由通道负责。

## L4 飞书：看详情按钮、详情卡、确认卡

- `plugins/feishu/src/card.ts`：审批卡第三键「看详情」（`decision: details`）；`buildApprovalDetailCard`
  （蓝 head，要做什么/任务/影响/判据/计划/时间线，**无按钮**，注明只读）；`buildApprovalConfirmCard`
  （红 head，「确认执行」`decision: confirm` + 拒绝），并补 payload 守卫。
- `plugins/feishu/src/transport.ts`：`approval.detail` → 新 interactive 消息；`approval.confirm` → patch 原卡，
  patch 失败回退文本；把 `patchApprovalCard` 泛化为 `patchCard`。

## L5 验证

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `verify-approvals` | **38/38** | R3 首击 `confirm-required`、再击仍不落定、换人 `confirm-invalid`、`confirmed` 落定且单次、R2 一击、读不改状态 |
| `verify-gateway` | **106/106** | details 只读端口（不调 answer）、详情缺失仍 `done`、`confirm-required` 不判 failed、`confirm→confirmed` 映射 |
| `verify-host` | **30/30** | 审批 1：R3 首击只出确认卡不改任务；审批 10：升 R3 后两次点击才执行；审批 11：看详情回显 intent/R3/`service_active` 且 nonce 未消费、任务仍挂起 |
| `verify-feishu` | **47/47** | 三键卡、详情卡内容/无按钮、`approval.detail` 独立消息、确认卡 patch 与按钮 value、patch 失败回退文本 |

回归：tasks 94、executor 18、snapshot 18、orchestrator 40、svcops 15/tools 25/inspection 27、governance 其余 7 套、
serve 12、release 7、deploy 7、`verify-invariants` 11 —— 全绿。

## L6 生产证据（release `2026.11.11-5`）

| 项 | 结果 |
|---|---|
| 迁移 | 先 `VACUUM INTO` 备份至 `/var/backups/dsh-wfxm/ops-pre-2026.11.11-5.sqlite`；启动后 `schema_migrations(approval)=2`，`approvals` 已有 `confirm_stage/confirm_actor/confirm_at` |
| 发布 | `release prepare/verify` 8/8 → `switch` 到 `2026.11.11-5` → `systemctl restart dsh-wfxm`；服务 `active`，`NRestarts=0` |
| 通道 | 飞书长连接 `ready`，`front:warm sdk` 正常 |
| 真机待办 | 两次点击与详情卡需 owner 在飞书里实点；本文只记「代码 + 单测 + 服务启动」证据 |

## L7 未做（本片边界）

- 详情卡不带决策按钮（避免出现第二张可点的有效卡）；要批准仍回原卡。
- 确认态无独立 TTL：沿用审批整体 `expires_at`；过期后首击记录随记录一起 `expired`。
- 首击者与确认者必须同一 actor；跨人交接（换人确认）未开放。
- 按钮级角色授权、签名/验签、审批卡在 Web 渠道的等价视图未做。

---

# Slice M — 任务日报（主动摘要，2026-11-11）

> 目标：把 `docs/05` G3 里缺的「任务/会话日报」补上。**不新增调度器**：复用巡检的每日闸，
> 任务摘要作为**独立一条消息**推送（自己的 dedupeKey），巡检日安静也不会吞掉它。
> 边界：只读 ⑤ 的 `listTasks()`，不直读表；不做逐任务 token/耗时统计；不做会话摘要。

## M1 纯函数 `plugins/tasks/src/digest.ts`

- `summarizeTaskDigest(tasks, {from, to, maxLines=5})`，窗口语义写死并注释：
  **已完成/失败/取消按 `finishedAt` 落在窗口内**；**在跑的五态是「现在」的快照**（不看到 `createdAt` 多老）。
- `createdAt > to` 的任务一律不计（防时钟/未来数据）；空窗口返回 `null`（不推「0 个任务」的噪音）。
- 文本：`任务日报 MM-DD：完成 N · 失败 N · 取消 N · 暂停 N · 待批准 N · 待补充 N · 进行中 N · 排队 N`（只列非零，顺序固定）；
  bullets ≤ `maxLines`，先列已结束（`finishedAt` 倒序），再列在跑（`createdAt` 倒序）；`taskRef` 优先，退化为 id 前 8 位；
  intent 压成单行、40 字截断；`maxLines: 0` 只留表头。
- `plugins/tasks/src/index.ts` 导出类型与函数。

## M2 调度复用（`plugins/svcops/src/patrol.ts`）

- `InspectionPatrolOptions.taskDigest?: ({from,to}) => string | null`：在既有「每天一次」的 digest 闸里调用，
  与巡检日报同窗口（默认 24h），**独立 push**，dedupeKey `task-digest:<YYYY-MM-DD>`。
- 抛错只 `warn('task digest failed: …')`，不影响本轮巡检/告警；当天已尝试过就不再重试（与巡检 digest 同一闸）。
- `pushed` 取值扩为 `digest+tasks` 等组合；无任务时保持 `null`/`digest`。

## M3 组合根（`scripts/serve.mjs`）

- 注入 `taskDigest: ({from,to}) => summarizeTaskDigest(host.stores.tasks.listTasks(), {from,to})?.text ?? null`
  —— ⑤ 拥有数据，组合根只读；无新表、无新配置项（沿用 `DSH_WFXM_DIGEST_HOUR`）。

## M4 验证

- 新增 `plugins/tasks/scripts/verify-digest.mjs`：**11 例**（空窗口不推、窗口边界、在跑快照、未来任务剔除、
  失败/取消分桶、表头顺序、仅在看任务、taskRef 与 id 回退、换行压平、40 字截断、`maxLines` 0/2、排序）。
- `scripts/verify-patrol.mjs` 8 → **12 例**：每日闸内调用一次并把窗口传对、两条 dedupeKey、
  空摘要不加消息、抛错隔离且当天不重试、未到点不调用。
- 回归：tasks 94、risk 12、svcops 15、svcops-tools 25、inspection 27、serve 12、invariants 11 —— 全绿。

## M5 生产证据（release `2026.11.11-6`）

| 项 | 结果 |
|---|---|
| 发布 | `release prepare/verify` 8/8 → `switch` 到 `2026.11.11-6` → `restart`；`active`，`NRestarts=0` |
| 首轮 tick | 20:45:49 `patrol cycle ok (pushed digest+tasks)`；两条独立出站：`patrol-digest:ubuntu:2026-11-11`、`task-digest:2026-11-11` |
| 实际内容 | `任务日报 11-11：完成 1` + `· b9dqbdzkxn · 已完成 · 列出 /tmp 下修改时间在 3 天前的空目录`（⑤ 真实数据） |
| 送达 | outbox `say` 行 `status=sent`、`sent_at=2026-11-11T12:45:50.825Z` |
| 待观察 | 同一天重复推送需次日/重启后确认（`task-digest:<date>` 去重）—— 已记入 `docs/06 §六` |

## M6 未做（本片边界）

- 会话级摘要（需要 `conversations` 视图）—— 已由 Slice N 承接，见下。
- 逐任务 token/耗时（dsh 事件里没有 usage 字段，见切片 F）。
- 历史任务全表扫描：`listTasks()` 无 `since`，v1 按量级可接受；数据变大后需在 ⑤ 增加时间过滤。
- 推送渠道仍是「最新活跃 binding」的 owner；多人群发未做。

# Slice N — 会话日报（结构化，2026-11-11 已上线）

> 目标：补 G3 最后一块「会话日报」。与任务日报同闸、同窗口，但**独立一条消息**（`conversation-digest:<date>`）。
> 边界：**不读/不渲染消息正文、不调模型**；只回答「哪些会话在活动、产出了哪些任务、最后何时」。
> 语义压缩（把对话总结成几句话）需要读 dsh session 日志，本片不做。无新表、无新配置、无新调度器。

## N1 ① 只读窗口（`plugins/gateway/src/store.ts`）

- `InboxFilter` 增 `since` / `until`（ISO，双端**闭区间**），供日报按 24h 窗口读取。
- 有时间窗时走独立 SQL（`received_at >= ? AND received_at <= ?`，ASC + rowid 稳定序），再叠加 `status`/`channelId` 过滤；
  无窗口时保持原有 prepared statements 路径，不改既有调用。

## N2 纯函数 `plugins/gateway/src/digest.ts`

- `summarizeConversationDigest({threads,messages,tasks,window})`：
  - 只统计 `kind='message'`（`card_action`/`control` 属于审批/控制，不算会话消息）；
  - 分组键 `threadId`，缺失回退 `chatId`；两者都空的行丢弃；
  - 任务按 `createdAt` 进窗，同线程按 `taskId` 去重（避免 default owner + anchors 重复计数）；
  - bullets 按最后活动倒序，`window.maxLines` 截断（默认 5）；
  - 同 chat 出现多个 thread 时，给 thread 组追加 `/<thread 后 6 位>`，防止 label 完全相同。
- 文本：`会话日报 MM-DD：会话 N · 消息 M · 新任务 K`（K=0 省略）；
  bullet：`· 会话/话题 xxxxxx · 消息 N（失败 n）· 新任务 K：intent… · 最后 HH:mm`。
  intent 单行化、24 字截断、最多 3 个；空窗口返回 `null`（不推 0 会话噪音）。

## N3 调度（`plugins/svcops/src/patrol.ts`）

- `InspectionPatrolOptions` 增 `conversationDigest?: ({from,to}) => string | null`，挂在既有每日 digest 闸内、
  任务日报之后；非空才 push，`pushed` 可能出现 `conversations` / `digest+conversations` / `digest+tasks+conversations`。
- 抛错只 `warn('conversation digest failed: …')`，不影响巡检与任务日报，当天不再重试。

## N4 组合根（`scripts/serve.mjs`）

- 只读拼装：① `listThreads()` + `listInbox({since,until})`，⑤ `listTaskThreads()` + `listTasks()`；
  不直读表、不写状态、不改 nonce/审批。

## N5 验证与生产证据

- 新增 `plugins/gateway/scripts/verify-conversation-digest.mjs` **16 例**：空窗口、root/topic label、chat 回退、
  非 message 行、失败计数、窗口外/重复任务、task-only 会话、未来数据、双端闭区间、无 id 行、maxLines 截断、intent 截断、同 chat 重名。
- `scripts/verify-patrol.mjs` **12 → 16 例**：会话摘要独立 dedupeKey 与窗口、空摘要不加消息、抛错隔离、未到点不调用。
- `verify-gateway` **106 → 107 例**：`listInbox` 闭区间窗口 + status/channel 组合。
- 回归：host 30 / feishu 47 / tasks 94 / digest 11 / serve 12 / invariants 11 / svcops 15 — 全绿。

| 项 | 结果 |
|---|---|
| 发布 | `2026.11.11-7` prepare/verify 8/8 → switch → restart（`active`、`NRestarts=0`）；`-8` 同流程修 label 重名 |
| 首轮 tick | 21:02 `patrol cycle ok (pushed digest+tasks+conversations)` |
| 实际内容 | `会话日报 11-11：会话 2 · 消息 3 · 新任务 1`；`· 会话 d53df8 · 消息 2 · 新任务 1：列出 /tmp 下修改时间在 3 天前的空目录 · 最后 16:35` |
| 送达 | outbox `conversation-digest:2026-11-11` `status=sent`、`sent_at=2026-11-11T13:02:17.857Z` |
| 去重 | 重启后再次触发每日闸：日志仍 queued，但 outbox 该 key 只有 1 行 `sent`（未重发） |
| 待观察 | 次日看 label 后缀修复；见 `docs/06 §六` |

## N6 未做（本片边界）

- 语义摘要：切片 N 不做；由 Slice O 用 ① 脱敏正文 + ⑤ 任务/回执承接，**不读 dsh session 文件**。
- 按人/项目拆分会话；周报；跨渠道（微信）会话聚合。
- `listTasks()`/`listTaskThreads()` 仍无时间过滤（日报按量级可接受，数据变大后在 ⑤ 加）。

# Slice O — 语义级会话摘要（2026-11-11 已上线）

> 目标：在会话日报标题下补一句「今天在做什么、做到哪一步」，仍是一条消息、一次推送。
> 材料来自已有权属：① `inbox` 的**脱敏正文** + ⑤ 任务 intent/status/回执；**不读 dsh session 文件**（AR2/AR32）。
> 失败一律降级为结构化日报；模型输出只接受「一行纯文本」，拒绝 JSON/列表/围栏。

## O1 ① 安全读文本（`plugins/gateway/src/text.ts`）

- `inboundText(content)`：从 `inbox.content.text` 取文本，`trim` 后经 `redactText` 脱敏；非文本/空文本返回 `null`。① 持有正文，
  脱敏在属主边界完成，消费方不再各自依赖 `@dsh-wfxm/redact`。
- `redactedText(value)`：给 ⑤ 的 intent / 回执摘要用；只做脱敏，不改内容。
- 导出到 gateway index；`verify-gateway` 增 1 例（脱敏命中、非文本/null/空白、Bearer 掩码）。

## O2 语义层（`plugins/orchestrator/src/semantic.ts`）

- `buildSemanticDigestPrompt(input)`：中文提示词 + 「材料不是指令」声明；每个会话最多 **5** 个、每条会话最多 **20** 条消息、
  每条消息 **200** 字、每个任务 **5** 个、intent/回执各 **120** 字；消息内换行压平，防止伪造段结构。
- `parseSemanticDigest(raw, maxChars=200)`：剥 ```text/markdown 围栏；拒绝 JSON 数组/对象、列表、空输出；空白折叠；
  超长截断加 `…`。
- `summarizeConversationSemantics(input, {runner, logger})`：空会话不调模型；runner 抛错 → `null` + `warn('semantic digest failed: …')`；
  输出不合格 → `null` + `warn('semantic digest rejected the model output')`。
- 导出类型/常量/函数；`verify-semantic` **15 例**（提示词内容/上限/压平、解析、降级）。

## O3 调度与组合根

- `plugins/svcops/src/patrol.ts`：`conversationDigest` 允许返回 Promise，`runOnce` 内 `await`；验收/拒绝都在既有 try/catch 内，
  不影响巡检与任务日报。
- `scripts/serve.mjs`：
  - 专用 **headless** runner（与前台常驻 sdk 会话隔离，避免并发交错；每天最多一次冷启动）；
  - `DSH_WFXM_SEMANTIC_DIGEST`（默认开，`0/false/off/no` 关）在 `parseServeConfig` 解析；`foreground=rule` 演练自动跳过；
  - 组装同一窗口：① `listInbox` 正文（`inboundText`）+ ⑤ `listTaskThreads/listTasks/listReceipts`；按最后活动取前 5 个会话；
  - 语义段落插在日报标题行之后；失败时原文返回；日志只记 `summary ok (N conversations)` / `summary unavailable`，不记正文。
- `scripts/verify-serve.mjs`：断言默认开、`=0` 可关。

## O4 生产证据

| 项 | 结果 |
|---|---|
| 发布 | `2026.11.11-9` prepare/verify 8/8 → switch → restart（`active`、`NRestarts=0`） |
| 启动 | 日志 `semantic enabled (headless, 60000ms)` |
| 首轮 | 21:14:38 `semantic summary ok (2 conversations)`（4.3s），随后 `patrol cycle ok (pushed digest+tasks+conversations)` |
| 去重 | 当日 outbox 该 key 仍只有 1 行 `sent`（13:02），语义段落不重复推送；次日新 key 会带上段落 |
| 真机单测 | 以 ailearn 手动跑 headless：`SUMMARY: 用户要求列出 /tmp 下修改时间在 3 天前的空目录，任务已成功完成…` |

## O5 未做（本片边界）

- 不读 dsh session 文件，因此看不到助手在 dsh 里的原始回复；材料是 ① 用户消息 + ⑤ 任务/回执。
- 不做逐会话语义段落（只做一条全局概述，避免 key 映射与多段噪音）；不做周报。
- 不在重启后跳过已发送 key 的模型调用（当天可能多算一次，代价是一轮 headless）。
- 语义摘要默认开启：脱敏后正文仍会进入配置的模型服务，敏感场景可用 `DSH_WFXM_SEMANTIC_DIGEST=0` 关闭。

# Slice P Tasks — 周报（待批准）

> 依据 `spec.md` 的「Slice P Spec」。目标：每周一封（近 7 天巡检 + 任务 + 会话），复用每日闸，
> 独立 `weekly-digest:<ISO周>`；周报日不叠加日报。**不新增调度器/表/模型调用**。

## P1 纯函数标题参数

- [x] `plugins/tasks/src/digest.ts`：`TaskDigestWindow` 增可选 `title`；默认仍是 `任务日报 MM-DD`，日报输出零变化
- [x] `plugins/gateway/src/digest.ts`：`ConversationDigestWindow` 增可选 `title`；默认仍是 `会话日报 MM-DD`
- [x] `verify-digest` 11 → 12（title 覆盖、默认不变）；`verify-conversation-digest` 16 → 17

## P2 ⑦ 周报段与周闸

- [x] `plugins/svcops/src/patrol.ts`：`DEFAULT_WEEKLY_DIGEST_DAY = 1`、`WEEKLY_WINDOW_HOURS = 168`
- [x] `PatrolConfig.weeklyDay` + `readPatrolConfig` 解析 `DSH_WFXM_WEEKLY_DIGEST_DAY`（-1..6，非法告警回落 1）
- [x] 导出 `isoWeekKey(at)`（本地日历 ISO 周，`YYYY-Www`）与 `formatInspectionWeek(digest)`
- [x] `InspectionPatrolOptions.weeklySections?: ({from,to}) => string|null|Promise<string|null>`
- [x] `runOnce` 每日闸内：周报日首次尝试 → 巡检 7 天聚合 + await `weeklySections`（异常隔离）→ 有内容则 push
      `weekly-digest:<week>`、`pushed += weekly`、置 `lastDigestDay`；为空/失败时回落日报

## P3 组合根

- [x] `scripts/serve.mjs`：抽出 `buildConversationDigest({from,to,title?,semantic})`，日报路径行为不变
- [x] 注入 `weeklySections`：⑤ 任务段（title `任务（近 7 天）`）+ ① 会话段（title `会话（近 7 天）`，`semantic:false`），全空返回 `null`

## P4 验证

- [x] `verify-patrol` 18 → 23（ISO 周跨年、周报段格式、配置开关、周报日取代日报、空段回落、非周报日/未到点不调用）
- [x] 全量回归：tasks 94 / digest 12 / conversation-digest 17 / gateway 108 / host 30 / feishu 47 / orchestrator 40 /
      serve 12 / patrol 23 / svcops 15 / invariants 11；逐包 `tsc`（svcops/tasks/gateway）全绿

> 实测：`isoWeekKey(2026-11-11)` = `2026-W46`（Spec 中的 W45 为手算笔误，已按测试结果为准）。
> 真实 store 在周报日必然先写入 1 条巡检记录，因此「周报段为空」仅作为防御性分支（异常注入用例覆盖）。

## P5 发布与回写

- [x] `release prepare/verify` → `switch` → `systemctl restart dsh-wfxm`（服务 `active`、`NRestarts=0`；release `2026.11.11-10`）
- [x] 周报链路验证：合成运行（loopback + `WEEKLY_DIGEST_DAY=3` + `DIGEST_HOUR=0`）`patrol cycle ok (pushed weekly)`；
      当日生产（周三，`weeklyDay=1`）只有三封日报、`weekly-digest:*` 0 行；首个周一真机观察已登记 `docs/06 §六`
- [x] 回写 `AGENTS.md §4`、`docs/05` G3、`docs/16 §九/§12.11`、`docs/06 §六`、`spec.md`（含 `W45 → W46` 更正）

# Slice Q — 出站失败可见（2026-11-12 已上线）

> 目标：outbox 重试 6 次耗尽后只落库 `failed`，此前没有任何日志/日报提示，飞书故障期间消息会静默丢。
> 本片让 **failed 与重试积压可见**：① 只读统计 + 分级日志 + 巡检日报/周报一行。
> **不改投递语义、不新增消息类型、不新增调度器/表**。

## Q1 ① 只读健康统计（`plugins/gateway/src/store.ts`）

- [x] `OutboxHealthInput { since?, now? }` / `OutboxHealth { failed, pending, retrying, oldestPendingAgeMs }`
- [x] `GatewayStore.outboxHealth(input?)`：窗口内 `failed`、全部 `pending`、`retrying`（attempts>0）、最老 pending 年龄（无积压为 `null`）
- [x] 纯只读 prepared statements；导出类型到 gateway index
- [x] `verify-gateway` 增 2 例（窗口过滤/积压/年龄、空队列零值与 `null`）

## Q2 dispatcher 分级日志（`plugins/gateway/src/dispatcher.ts`、`plugins/host/src/host.ts`）

- [x] `OutboxDispatcherOptions.logger?{warn,error}`：排定重试 → `warn`（含 id/topic/attempt/max/nextRetryAt/错误），
      耗尽 → `error`（含 id/topic/attempt/错误）；**不记录 payload**
- [x] 两处失败路径（transport 抛错、缺少 `external_msg_id`）共用 `recordFailure`，报告计数不变
- [x] host 把自身 logger 注入 dispatcher；logger 无 `error` 时降级到 `warn`；serve 的 host logger 增 `error` → `host:error`
- [x] `verify-gateway` 增 1 例（warn/error 级别、id、payload 不入日志）；`verify-host` 增 1 例（失败 transport 经 host logger 可见）

## Q3 ⑦ 日报/周报一行（`plugins/svcops/src/patrol.ts`）

- [x] `InspectionPatrolOptions.outboxDigest?: ({from,to}) => string | null`
- [x] 日报：`formatInspectionDigest` 末尾追加该行；周报：附加段之后追加；异常 `warn('outbox digest failed: …')` 且不影响正文
- [x] `verify-patrol` 23 → 26（日报窗口与行内容、异常隔离、周报行）

## Q4 组合根（`scripts/serve.mjs`）

- [x] `outboxDigest` 读取 `gatewayStore.outboxHealth({since: from, now: to})`，格式 `出站：失败 N · 积压 M`（重试 >0 时附 `（重试 K）`）

## Q5 验证与发布

- [x] 全量回归：gateway 111 / host 31 / feishu 47 / orchestrator 40 / tasks 94 / svcops 15 / patrol 26 /
      digest 12 / conversation-digest 17 / serve 12 / invariants 11；gateway/svcops/host `tsc` 全绿
- [x] `release prepare/verify` → `switch` → `systemctl restart dsh-wfxm`（release `2026.11.12-1`，`active`、`NRestarts=0`）
- [x] 生产快照：`outboxHealth` 24h = `失败 0 · 积压 0`（今日日报已被旧 release 以 `patrol-digest:ubuntu:2026-11-12` 去重，行内容次日可见）
- [x] 回写 `spec.md`、`AGENTS.md §4`、`docs/05` G3、`docs/16 §九/§12.12`、`docs/06 §六`

# Slice R — 长任务可见（2026-11-12 已上线）

> 目标：`running` 任务超过 2/10 分钟在飞书各提醒一次；超过 15 分钟无新事件提示「可能卡住」。
> **不改状态机、不自动暂停、不新增调度器/表**；复用 host pump + outbox `dedupeKey`。
> 规格见 `spec.md` Slice R Spec（§7 实施记录）。

## R1 ⑤ 只读快照

- [x] `plugins/tasks/src/store.ts`：`latestEvent(taskId): TaskEvent | null`（`ORDER BY seq DESC LIMIT 1`）
- [x] host 适配器基于 `listTasks({status:'running'})` + `listTaskThreads({liveOnly:true})` + `latestEvent` 组装 `RunningTaskSnapshot`

## R2 ① 进度公告 relay（新增 `plugins/gateway/src/task-progress.ts`）

- [x] `TASK_PROGRESS_TOPIC='task.progress'`、`TaskProgressPort`、`createTaskProgressRelay`
- [x] 里程碑取「当前已达最高一档」，`dedupeKey=task-progress:<taskId>:<milestoneMs>`；默认 2/10 分钟
- [x] stall 默认 15 分钟，`dedupeKey=task-progress:<taskId>:stall:<lastEventSeq>`；新事件后可再提醒一次
- [x] 无线程 / 线程不在 ① `threads` → `skippedNoThread`，不报错；payload 带 `text`，适配器零改动
- [x] `GatewayStore.findOutboxByDedupe` 前置去重，`skippedDuplicate` 计数

## R3 host 组合

- [x] `HostProgressOptions` / `progress?`（默认启用、`null` 关闭）；pump 顺序 receipt → progress → dispatch
- [x] `HostPumpReport.progress`；host 内实现 `TaskProgressPort`

## R4 配置（`scripts/lib/startup.mjs`、`scripts/serve.mjs`）

- [x] `DSH_WFXM_TASK_PROGRESS`（默认开）、`DSH_WFXM_TASK_MILESTONES`（默认 `2,10`）、`DSH_WFXM_TASK_STALL_MINUTES`（默认 `15`，`0` 关闭）
- [x] 非法值启动失败；`modules` 日志带 progress 配置

## R5 验证与发布

- [x] `verify-gateway` 111 → 115（里程碑各一次/重跑不重发、停机只发最高档、stall 与 seq 重置、无线程跳过）
- [x] `verify-host` 31 → 34（pump 当轮投递且只一次、完成前不提醒、无线程跳过）
- [x] 全量回归 + gateway/host `tsc`（feishu 47 / orchestrator 40 / tasks 94 / svcops 15 / patrol 26 / serve 12 / invariants OK）
- [x] `release prepare/verify` → `switch` → `systemctl restart dsh-wfxm`（`2026.11.12-2`，`active`、`NRestarts=0`）
- [x] 发布产物冒烟：已安装 release + 3 分钟前 `started_at` → 当轮入队并投递 1 条；重跑 `skippedDuplicate=1`，同 `dedupe_key` 仅 1 行
      （真实飞书投递待 owner 按 `docs/06 §六` 触发 >2 分钟任务）
- [x] 回写 `spec.md` §7、`AGENTS.md §4`、`docs/05` V5、`docs/16 §九/§12.13`、`docs/06 §六`

# Slice S — 巡检快问扩展（2026-11-12）

> 目标：显式点名的托管 unit、数字端口、错误日志条数走毫秒级直答；读不到就落回模型，不猜。
> **不改 ⑦/① 代码、不新增表/调度器/配置项**。

## S1 匹配与格式化（`plugins/orchestrator/src/quick-answer.ts`）

- [x] `QuickRequest` / `parseQuickRequest`；`matchQuickRequest` 保持原签名供旧用例使用
- [x] unit：完整 `*.service`、`dsh-wfxm-managed-*`、`<英文名> 服务` → 托管前缀；无目标返回 `null`
- [x] port：含「端口/port」且数字在 1–65535
- [x] logs：错误/报错日志；排除今天/昨天/本周/上周/7 天窗口；「N 分钟」覆盖默认 15
- [x] `formatUnitStatus` / `formatPortStatus` / `formatLogErrors`（读不到一律 `null`）

## S2 前端分派与导出

- [x] `createQuickAnswer({ tasks, probe, checks })` 分派 units/ports/logs；缺方法/抛错 → 落回模型
- [x] `foreground.ts` 增 `checks?` 并透传；`index.ts` 导出新类型/函数

## S3 接线

- [x] `scripts/serve.mjs`：`systemd.status` + `probeListeningPorts` + `probeLogErrors`（默认窗口取巡检配置）
- [x] `scripts/dev-web.mjs` / `scripts/e2e-smoke.mjs`：同上

## S4 验证

- [x] `verify-orchestrator` **40 → 46**（unit 显式/短名、端口两态、日志窗口、无 checks 落回、匹配保守性）
- [x] 回归：host 34 / gateway 115 / svcops 15 / inspection 27 / patrol 26 / serve 12 / invariants OK；orchestrator `tsc` 全绿
- [x] 真实探针冒烟：`看看 22 端口通吗` → `端口 22：正在监听。`；`最近 15 分钟错误日志多少条` → `最近 15 分钟没有错误日志（journalctl -p err）。`
- [x] `release prepare/verify` → `switch` → `systemctl restart dsh-wfxm`（`2026.11.12-3`，`active`、`NRestarts=0`）；已安装 release 冒烟通过
- [x] 回写 `spec.md`、`tasks.md`、`AGENTS.md §4`、`docs/06 §六`

# Slice T — 运维加固（2026-11-12 已上线）

> 目标：备份从「有脚本」变成「每天真的跑」；归档按份数轮转；日志有上限。
> **不改备份内容/还原演练、不引入新依赖**。

## T1 保留策略（`scripts/backup.mjs`）

- [x] `--keep N` / `DSH_WFXM_BACKUP_KEEP`（默认 `7`）；`0` 表示不清理；`--no-prune` 显式关闭
- [x] 非法 keep 显式失败，且不写新归档
- [x] 只匹配 `dsh-wfxm-YYYYMMDDTHHMMSSZ.tar.gz` 与 `.sha256`；其他文件永不删除
- [x] 备份成功后按 tag 倒序保留最新 N 份，日志 `prune: kept N, removed M (keep=K)`

## T2 定时备份与日志上限

- [x] `deploy/systemd/dsh-wfxm-backup.service`：oneshot、dshwfxm、同一 env、只写数据/备份目录
- [x] `deploy/systemd/dsh-wfxm-backup.timer`：每日 03:30、`RandomizedDelaySec=15m`、`Persistent=true`
- [x] `deploy/journald/10-dsh-wfxm.conf`：500M / 50M / 30day

## T3 安装与配置

- [x] `deploy/install.sh`：安装两个 unit + drop-in；journald 仅内容变化时 restart；只 `enable` timer
- [x] `dsh-wfxm.env.example`：`DSH_WFXM_BACKUP_DIR`、`DSH_WFXM_BACKUP_KEEP`

## T4 验证与发布

- [x] `verify-backup` **6 → 9**（--keep 2 轮转、--keep 0 全留、非法 keep 失败且不落盘）
- [x] `verify-deploy` **7 → 11**（backup unit、timer + journald、install.sh、systemd-analyze/cat-config）
- [x] 回归：`verify-serve` 12、`check-invariants` OK
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-5`，`active`、`NRestarts=0`）
- [x] 生产：`systemctl start dsh-wfxm-backup.service` → `Result=success`；新归档 + sidecar；`prune: kept 1, removed 0 (keep=7)`；timer active
- [x] 回写 `spec.md` Slice T、`AGENTS.md §4`、`docs/16 §三/§七/§八/§12.14`、`docs/06 §六`

# Slice U — B4-b 工作区隔离 Phase 1（2026-11-12 已上线）

> 目标：有项目 → 用项目根；git 干净仓库 → 一任务一 worktree/分支；失败显式，不回落共享目录。
> **默认关闭**（`DSH_WFXM_WORKTREE_ISOLATION=1` 才启用），关闭时行为与 Slice T 一致。

## U1 字段与迁移

- [x] `tasks` v6：`isolation/worktree_path/base_commit/branch/merge_state/prepare_state/prepared_at` + 两索引
- [x] `setIsolation()` 单写入口；worktree 缺三件套 → `invalid-task`
- [x] `projects` v3：`vcs/prepare_cmd/worktree_root/merge_mode`；升级时按 `.git` 回填 `vcs=git`
- [x] `upsertProject` 自动识别 git，显式 `vcs` 优先

## U2 判定、创建与执行

- [x] `isolation.ts`：非 git / 脏 / 非仓库根 → serial；git → worktree + `wfxm/<task_ref>` 分支
- [x] 已有 worktree 复用；prepare 失败/目录丢失 → 报错，不重建、不重跑
- [x] `prepare_cmd` 只跑一次（10 分钟超时），成功 `done + prepared_at`，失败 `failed`
- [x] executor `workdirResolver` 支持 Promise；失败 → 任务 failed，不 spawn
- [x] worker 结算前重读任务，验证 cwd 跟随 worktree

## U3 接线与开关

- [x] `serve.mjs` 按 `projectId` 取项目根并注入 resolver
- [x] `DSH_WFXM_WORKTREE_ISOLATION`（默认 false）；关闭时不传 resolver
- [x] env 模板注释给出开关，安装默认不打开

## U4 验证与发布

- [x] 新增 `verify-isolation` **10/10**（判定、双 worktree、prepare、失败、越界、回落）
- [x] `verify-tasks` 94、`verify-knowledge` 45、`verify-executor` 19、`verify-serve` 12、`verify-host` 34
- [x] `check-invariants` OK
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-6`）；生产迁移后 `projects` 为空、开关关闭
- [x] 回写 `spec.md` Slice U、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8`、`docs/16 §12.15`、`docs/06 §六`

# Slice V — B4-b 合并与清理 Phase 2（2026-11-12 已上线）

> 目标：worktree 任务能真正收尾——手动合并、幂等释放、保留期清理。
> **不自动合并、不做 PR、不解决冲突、不引入 `resource_locks`**；冲突用 `merge_state=conflict` 表达。

## V1 状态机收紧

- [x] `model.ts` 新增 `assertMergeTransition`（15 §10.5 白名单）与 `task.merge` 事件类型
- [x] `store.setIsolation` 校验 merge 迁移；serial 任务不得带 merge 状态

## V2 合并（新增 `plugins/tasks/src/merge.ts`）

- [x] `createIsolationService`：`merge / release / prune / status`
- [x] 前置：worktree 三件套、`succeeded`、`merge_state ∈ {none,conflict}`、目标是仓库根
- [x] 同仓库串行：进程内队列 + `<git-common-dir>/wfxm-merge.lock`（陈旧锁 10 分钟）
- [x] 主仓库与 worktree 都必须干净；分支缺失 → `not-found`，不重建
- [x] 成功：`merged` + `task.merge` 事件 + `worktree remove --force` + `branch -d`
- [x] 冲突：收集 unmerged paths → `merge --abort` → `conflict`，任务状态不变
- [x] 其它失败：abort + 恢复原 `merge_state` + 抛 `transient/unknown`

## V3 释放与保留期

- [x] `release` 幂等：目录在则删、缺失则 `worktree prune`；第二次 `alreadyReleased`
- [x] `merged` 才允许按 merged 释放；`abandoned|failed` 保留分支供诊断
- [x] `prune`：终态 + `merge_state ∈ {none,merged}` + 超过保留期（默认 7 天）
- [x] `prune --dry-run` 只列不删；`none → abandoned`

## V4 入口与导出

- [x] `plugins/tasks/src/index.ts` 导出 `createIsolationService` 与类型
- [x] 新增 `scripts/isolation.mjs`：`status / merge / release / prune`，退出码 0/1/2
- [x] CLI 不依赖开关：关闭时仍可收尾已有 worktree

## V5 验证与发布

- [x] 新增 `verify-merge` **10/10**（成功、重复合并、冲突、冲突重试、脏 worktree、脏主仓库、分支缺失、释放幂等、prune、非法迁移）
- [x] 回归：`verify-isolation` 10 / `verify-tasks` 94 / `verify-knowledge` 45 / `verify-executor` 19 / `verify-serve` 12 / `verify-host` 34 / `verify-deploy` 11 / `verify-backup` 9 / `invariants` OK
- [x] `tsc -p plugins/tasks/tsconfig.json` 全绿；CLI 冒烟（临时仓库 + 临时库）
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-7`）；生产只读核对，不造任务
- [x] 回写 `spec.md` Slice V、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8/§10.9`、`docs/16 §12.16`、`docs/06 §六`

# Slice W — 项目登记入口（2026-11-12）

> 目标：让 `projects` 表能真正登记 git 项目，worktree 隔离才有对象。
> **不自动登记生产项目、不打开 `DSH_WFXM_WORKTREE_ISOLATION`**；登记只是允许，启用由 owner 决定。

## W1 入口 `scripts/projects.mjs`

- [x] `add --name --root [--prepare-cmd] [--worktree-root] [--merge-mode manual|pr] [--vcs git|none]`
- [x] `list [--all] [--json]`：默认只列未归档，输出 `id name vcs merge root`
- [x] `update <id|name>`：只改提供的字段；`--prepare-cmd ""` 清空
- [x] `remove <id|name>`：归档（不物理删除），重复调用幂等

## W2 校验

- [x] `--root` 必须存在且为目录，登记 `realpath`
- [x] `--vcs` 缺省按 `<root>/.git` 探测；显式 `git` 但无 `.git` → 拒绝
- [x] `--worktree-root` 必须在 root 内（`resolve` 后按前缀判断）
- [x] `--merge-mode pr` 要求 git 且 `git remote` 非空
- [x] 重复 name / 重复 root 拒绝；`add` 不覆盖既有项目（先查 name 再插）

## W3 验证与发布

- [x] 新增 `verify-projects-cli` **10/10**（登记/非 git/坏 root/越界 worktree_root/重复/update/remove/PR 无远端 + 未知命令/缺参 + 迁移版本）
- [x] 回归：`verify-knowledge` 45 / `verify-isolation` 10 / `verify-merge` 10 / `verify-serve` 12 / `invariants` OK
- [x] `tsc -p plugins/knowledge/tsconfig.json` 全绿（未改 TS，仅确认）
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-8`）；生产只读核对 `projects=0`、开关关闭
- [x] 回写 `spec.md` Slice W、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8`、`docs/16 §12.17`、`docs/06 §六`

# Slice X — 非文件资源锁（`resource_locks`，2026-11-12）

> 目标：端口 / DB / unit / docker / git 合并由租约串行；本片只交付表 + API + 结算释放，
> **任务尚未声明资源，生产行为不变**。

## X1 迁移与 store API

- [x] `tasks` v7：`resource_locks` 表 + `ux_resource_lock_live` + `ix_resource_locks_lease`
- [x] `acquireResourceLocks`：事务内清扫过期 → 冲突收集 → 全有或全无插入
- [x] `heartbeatResourceLocks`：只续活租约，返回 `liveIds` / `expiresAt`
- [x] `releaseResourceLocks` / `releaseTaskResourceLocks` 幂等
- [x] `listResourceLocks`：默认只算活租约（`lease_expires_at > now`），`includeReleased` 全量

## X2 规范化与服务

- [x] `normalizeResourceKey`：`port` / `db` / `unit` / `docker` / `git`，非法前缀与值拒绝
- [x] `normalizeResourceKeys`：去重 + 排序；空列表拒绝
- [x] `createResourceLockService`：争用返回 `conflict`（含持有者），不抛错
- [x] TTL 默认 300s、范围 1s–24h；心跳与过期语义

## X3 生命周期与导出

- [x] worker 结算后（Verifier 之后）调用 `releaseTaskResourceLocks`
- [x] `stale-lease` 不释放；进程崩溃由 TTL 兜底
- [x] `plugins/tasks/src/index.ts` 导出类型与 `createResourceLockService`

## X4 验证与发布

- [x] 新增 `verify-resource-locks` **12/12**（规范化 / 全有或全无 / 冲突 / TTL / 心跳 / 幂等 / 未知任务）
- [x] `verify-tasks` 迁移断言更新到 v7 + 新表/索引（94/94）
- [x] 回归：`verify-isolation` 10 / `verify-merge` 10 / `verify-executor` 19 / `verify-knowledge` 45 / `verify-serve` 12 / `invariants` OK
- [x] `tsc -p plugins/tasks/tsconfig.json` 全绿（build 后跑测试）
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-9`）；生产只读核对
- [x] 回写 `spec.md` Slice X、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8/§10.9`、`docs/16 §12.18`、`docs/06 §六`

# Slice Y — 计划声明资源与自动 acquire（2026-11-12）

> 目标：把 `resource_locks` 接进执行路径，让「两任务抢同一端口，第二个排队」真正成立。
> 开关 `DSH_WFXM_RESOURCE_LOCKS` 默认 **false**；不声明资源的任务行为不变。

## Y1 声明与校验

- [x] `declaredResources(plan)`：读 `plan.resources`，缺省/`null`/空数组为 `[]`
- [x] `createTask` 写入前校验，非法键 → `invalid-task`
- [x] `task_submit` 新增可选 `resources`，转成 `plan.resources`

## Y2 worker 自动 acquire

- [x] R3 快照之后、执行之前申请全部键
- [x] 争用 → `deferTask()` 回 `queued`，`attempt - 1`，写 `task.deferred`（含阻塞键）
- [x] 同任务重复 acquire 幂等（复用并延长，不判冲突）
- [x] 申请异常（键非法/DB 错误）→ 任务终态失败，不静默跳过

## Y3 心跳、失租与释放

- [x] `keepAlive()` 同时续任务租约与资源租约，并作为执行器 `hooks.heartbeat`
- [x] 资源丢失 → 心跳返回 false；结算前强制按 `conflict` 失败
- [x] Verifier 之后释放该任务全部租约；`stale-lease` 不释放

## Y4 配置与接线

- [x] `DSH_WFXM_RESOURCE_LOCKS`（默认 false）进 `parseServeConfig`
- [x] host worker 选项透传 `resourceLocks / resourceTtlSec / resourceRetryMs`
- [x] `scripts/serve.mjs` 接线 `worker.resourceLocks`

## Y5 验证与发布

- [x] `verify-resource-locks` 扩到 **19/19**（defer 不烧 attempt、顺序执行、开关关闭、心跳延长、失租失败）
- [x] 回归：`verify-tasks` 94 / `verify-isolation` 10 / `verify-merge` 10 / `verify-executor` 19 / `verify-knowledge` 45 / `verify-host` 34 / `verify-serve` 12 / `invariants` OK
- [x] `tsc -p plugins/tasks` + `tsc -p plugins/host` 全绿（build 后跑测试）
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-10`）；生产只读核对
- [x] 生产 smoke：`DSH_WFXM_RESOURCE_LOCKS=1` 后，`port:tcp:65500` 被占 → `queued`/`attempt=0`/`task.deferred`；释放后 `succeeded`（receipt `OK`），live 锁 0，holder 已取消
- [x] 回写 `spec.md` Slice Y、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8/§10.9`、`docs/16 §12.19`、`docs/06 §六`

# Slice Z — merge 使用 `git` 资源锁（2026-11-12）

> 目标：合并从「仅文件锁」扩到 `resource_locks` 的 `git:<repoRoot>`，跨进程可见；
> 纯内部改造，合并结果语义不变。

## Z1 实现

- [x] `withGitResourceLock()`：申请 `git:<realpath(repoRoot)>`，TTL 600s，100ms 重试到 `lockTimeoutMs`
- [x] 合并路径顺序：`withRepoLock → withGitResourceLock → git merge`
- [x] 超时抛 `conflict`（不改 `merge_state`）；成功/冲突/异常 `finally` 释放
- [x] `prune` / `release` 不取 git 锁，保持原行为
- [x] 文件锁保留，既有合并/清理语义不变

## Z2 验证与发布

- [x] `verify-merge` 扩到 **12/12**（合并期间持有 `git:`；被占等待超时后释放可合并）
- [x] 回归：`verify-tasks` 94 / `verify-isolation` 10 / `verify-resource-locks` 19 / `verify-executor` 19 / `verify-host` 34 / `verify-knowledge` 45 / `verify-serve` 12 / `invariants` OK
- [x] `tsc -p plugins/tasks/tsconfig.json` 全绿
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-11`）；生产核对无 `git:` live 残留
- [x] 回写 `spec.md` Slice Z、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.7`、`docs/16 §12.20`、`docs/06 §六`

# Slice AA — 资源锁运维入口（2026-11-12）

> 目标：资源锁可查、可收尾；未声明资源的 B 域任务「不进表、按 workspace 串行」加测试固定。

## AA1 CLI

- [x] 新增 `scripts/locks.mjs list [--all] [--json]`
- [x] `release <lockId>`：幂等
- [x] `release --task <taskId|taskRef>`：释放该任务全部 live 租约
- [x] 不提供 acquire；未知任务/命令退出 1

## AA2 B 域串行与验证

- [x] `verify-resource-locks` 加「未声明资源任务不产生锁行」（20/20）
- [x] 新增 `verify-locks-cli` **7/7**
- [x] 回归：`verify-tasks` 94 / `verify-isolation` 10 / `verify-merge` 12 / `verify-resource-locks` 20 / `verify-executor` 19 / `verify-host` 34 / `verify-knowledge` 45 / `verify-serve` 12 / `invariants` OK
- [x] `tsc -p plugins/tasks/tsconfig.json`（无 TS 改动，确认）
- [x] `release prepare/verify` → `switch` → `restart`（`2026.11.12-12`）；release 内 `locks.mjs --help` 冒烟，生产 `list` 为空
- [x] 回写 `spec.md` Slice AA、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8`、`docs/16 §12.21`、`docs/06 §六`

# Slice AB — 生产启用 worktree 隔离（2026-11-12）

> 目标：登记 demo 项目并打开 `DSH_WFXM_WORKTREE_ISOLATION=1`，用 R0 任务完成验收 1/3 真跑；
> 不改真实仓库权限。

## AB1 准备与启用

- [x] 建 demo 仓库 `/var/lib/dsh-wfxm/projects/demo`（dshwfxm 所有，初始提交）
- [x] `projects.mjs add --name demo --root … --merge-mode manual`；`list` 显示 `vcs=git`
- [x] `/etc/dsh-wfxm/env` 设 `DSH_WFXM_WORKTREE_ISOLATION=1`；restart 后 `active`/`NRestarts=0`
- [x] 进程环境确认两个开关均为 `1`

## AB2 E2E 与清理

- [x] R0 任务（`projectId=demo`）：`succeeded`、`isolation=worktree`、worktree 存在、receipt `OK`
- [x] `isolation.mjs release --reason abandoned`：worktree 删除、`merge=abandoned`、`exists=no`
- [x] 删除残留 `wfxm/*` 分支；主仓库 `git status --porcelain` 为空
- [x] 只读核对：`projects=1`、`resource_locks` live=0、`tasks` v7；无需新 release（沿用 `2026.11.12-12`）
- [x] 回写 `spec.md` Slice AB、`AGENTS.md §4`、`docs/11 §14.7`、`docs/15 §10.8`、`docs/16 §12.22`、`docs/06 §六`

## AB3 B4-b 四项手工验收（2026-11-12，demo）

- [x] 双任务 worktree：两个分支同时改 `notes.txt`，各自 A/B 互不影响，主仓库干净
- [x] 手动合并：`merge` → `merge_state=merged`、commit `2b7084d`、worktree/branch 删除、任务仍 succeeded
- [x] 合并冲突：B 退出码 2、`merge_state=conflict`、无半合并；解决后重跑 merged、清理完成
- [x] 保留期清理：dry-run 列 2 个候选；真实 prune `removed 2, failed 0`；`none→abandoned`；conflict 不动
- [x] 清理手工 fixture 与残留分支；服务 `active`、`NRestarts=0`、worktree 残留 0
- [x] 回写 `docs/06` 四行、`docs/11 §14.7`、`AGENTS.md §4`

## AC R3 卡片交互修复（2026-11-13，release 2026.11.12-20）

- [x] 审批卡补 `update_multi=true`，`message.patch` 可生效
- [x] 快照空工作区先建 `.tmp`，消除 `snapshot-failed` ENOENT
- [x] `confirm-required` 返回成功 toast，不再显示「处理失败」
- [x] 回调响应内嵌下一张卡（`toCardActionResponse`），不再与回调渲染竞争
- [x] `host.pump()` 后台执行，回调不再超时
- [x] `verify-feishu` 49/49、`verify-snapshot` 19/19；发布 `2026.11.12-20`
- [x] 真实卡片视觉复验：2026-11-13 生产 Web 端点击——批准→红头「R3 · 请再次确认」（红 `rgb(245,74,69)`，无弹回）；确认执行→绿「已批准」+ `nonce_consumed_at`；`docs/06` 116/117 转 ☑
- [x] 审批过期无清扫 → 已修（`2026.11.13-1`）：`ApprovalStore.expireOverdue()` + `host.pump()` 先清扫，任务 `waiting_approval → failed`、卡片灰头「已过期」；`verify-approvals 42/42`、`verify-host 35/35`，生产已切
- [x] 托管 unit fixture：已建 `dsh-wfxm-managed-demo.service`；「重启 demo 服务」任务 `urg85xchrk` `service_active: pass`、`succeeded`
- [x] 提权改 root 侧白名单 helper：`deploy/bin/unit-control-server.mjs` + client + `dsh-wfxm-unit-control.service`；`env` 指向 client；真重启验证（PID 3962006→3966941，越权被拒 `bad-unit`）
- [x] 判据补强：新增 `unit_restarted(unit)`（`ActiveEnterTimestamp` vs `startedAt`），规则层模板改为 `unit_restarted` + `service_active`；schema v8；生产 `dvkqw2sjdj` 两条均 `pass`（`2026.11.13-3`）
- [x] `svc_logs` 读 journal：服务用户加入 `systemd-journal` 组并重启服务；生产任务 `kdumgf6gnt` 回执含 41 行日志
- [x] 修误升级：「…判断该服务启动是否正常」不再被判成重启（verb 需在 unit 前后 14 字内且非状态问句），`verify-orchestrator 47`；同请求现为 R0（`2026.11.13-4`）
- [x] 修「拒绝后线程被占死」：`paused` 仅对控制帧可锚定，前台 live 列表去掉 `paused`，⑤ 新绑定 supersede 旧 paused owner；生产 `d4qxju6nh5` 验证（`2026.11.13-7`）
- [x] 手工验收补跑：双击批准 124、拒绝 128、快问 144–146、长任务提醒 141–143 全部通过（2026-11-13）
- [x] R2 入口：规则层「写绝对路径文件 → R2 + `file_exists`」；生产 R2 卡单击直接放行（`confirm_stage=0`），`verify-orchestrator 50`（`2026.11.13-9`）
- [x] R2 写文件的路径可写边界（`2026.11.16-2`）：交付物在默认 workspace 内的任务留在该 workspace 跑（`isolation=serial`），`policy.yaml` 放行该根；生产任务 `7ygzjh249h` `file_exists: pass`（见 `docs/06`）
- [x] 回写 `spec.md`、`docs/06`、`AGENTS.md §4`、`docs/16 §12.23`
- [x] B3 v1 静默任务结构化提醒（`2026.11.16-3`）：`task.progress` 带 `stuckAt/stuckPhase/options`，正文给「停止 `<ref>`」；不自动暂停（无协作式取消）；`verify-gateway 115/115`、`verify-host 35/35`（Slice AI）
- [x] 协作式取消（`2026.11.16-4`）：`停止` 先 abort executor 子进程再落 `cancelled`；worker 遇 `cancelled` 只释放锁并返回 `skipped:'cancelled'`，不再 settle/迁移/补回执；`verify-executor 20`、`verify-tasks 97`、`verify-host 36`（Slice AJ）
- [x] 纯文本控制命令（`2026.11.16-5`）：英文可裸用、中文必须带 ref 且整句锚定；生产 `停止 bkgg4bba8m` 命中 control，未新建任务；`verify-gateway 116/116`（Slice AK）
- [x] B2 v1 主动候选路径（`2026.11.18-1`）：仅主机巡检发现项、全部 observe；候选表唯一键去重/恢复重开；即时告警附 observe、日报加候选段；生产演练失败 unit → open → resolved（Slice AM）
- [x] 工程门禁（`2026.11.18-2`）：`scripts/build.mjs`（逐包 tsc / `--noEmit`）、`scripts/check-style.mjs`、`scripts/verify-all.mjs`（显式清单 + 漂移检测 + `--ci`）、GitHub Actions；本地全量 41 passed + 1 advisory，`--ci` 全绿（Slice AN）
- [x] 服务健康告警（`2026.11.18-2`）：`scripts/health-alert.mjs` + `dsh-wfxm-health.{service,timer}`（2 分钟）+ 主服务 `OnFailure=`；同状态 30 分钟冷却，状态变化立即发；`verify-health-alert` 7/7；本机 timer 已 enable 并验证 `healthy`（Slice AN）
- [x] 对话连续性（`2026.11.18-3`）：`threadHistory` + 决策 prompt 最近 8 轮 + SDK 按 thread 独立会话；`steerTask` 让补充指令在 running 时打断重跑（attempt 归零、输入 delivered→read），queued 合并、waiting_* 记录；host 两条路由都应用并回执；`verify-gateway 118`/`verify-tasks 102`/`verify-orchestrator 52`/`verify-host 39`（Slice AO）
- [x] 消息去重（`2026.11.18-4`）：① 在 triage 前对同线程紧邻同文本消息按窗口（默认 60s，`DSH_WFXM_DUPLICATE_WINDOW_SECONDS`）忽略，重复消息不建任务/不投递/不打断/不回执；仅纯文本，control 与卡片动作不受影响；`verify-gateway 119`、`verify-host 41`，全量 41 套件通过（Slice AO.1）
- [x] 任务执行上下文（`2026.11.18-5`）：⑤ 新增 `recentThreadResults(taskId, 2)`（同线程 succeeded 回执，排除自身），worker 组装 `threadContext`（2 条、每条 300 字）传给执行器，executor 拼在 intent 之后同 stdin 送入；只读 ⑤ 自己的表、读取失败不阻塞；`verify-tasks 104`、`verify-executor 21`，全量 41 套件通过（Slice AP）
- [x] 重启后前台 SDK 会话续接（`2026.11.18-6`）：`runOnThreadSession` 命中 `session "<threadId>" already exists` 时 `resumeSession` 并重试一次，其他错误不恢复；修复重启后老线程决策静默降级到规则；`verify-orchestrator 54`，全量 41 套件通过（Slice AQ）

# Slice AR — 等待输入闭环（D11，2026-11-18）

> 目标：打通「执行中缺信息 → `waiting_input` → 追问 → 用户回复 → 继续执行」；
> 不新建表，问题存 `task_events`。

## AR1 执行器协议

- [x] `plugins/executor/src/executor.ts`：`ExecOutcome` 增加 `needs_input`（含 `question`）
- [x] prompt 末尾追加 `[[NEED_INPUT]]` 约定（intent / threadContext 之后）
- [x] 退出码 0 且最终文本含标记 → checkpoint `aborted` + `needs_input`
- [x] 正常成功/失败/超时/取消路径不变

## AR2 ⑤ 停放与唤醒

- [x] `plugins/tasks/src/model.ts`：`waiting_input` 允许到 `queued`；新增事件 `task.input_requested`
- [x] `plugins/tasks/src/store.ts`：`parkForInput`（running → waiting_input，清租约，事件带 question）
- [x] `steerTask` 的 `waiting_input` 分支改为追加 intent 后回 `queued`（`applied='rerun'`）
- [x] `plugins/tasks/src/worker.ts`：`needs_input` → `parkForInput`，报告 `needs-input`；非 running 时不写回执

## AR3 host 投递

- [x] `plugins/host/src/host.ts`：`pump()` 扫描 `waiting_input` 的 `task.input_requested`
- [x] 按 `task-input-request:<taskId>:<seq>` 去重，向 live 线程入队追问
- [x] 用户回复走 AO 路径：入队输入 → `steerTask` → `queued` + 回执

## AR4 验证与发布

- [x] `verify-tasks`：停放/事件/唤醒/非法状态（107）
- [x] `verify-executor` + `stub-dsh`：标记识别、prompt 约定、既有路径回归（23）
- [x] `verify-host`：pump 只入队一次；回复后回 `queued`（41）
- [x] `build` / `--noEmit` / `check-style` / `verify-all`（41 套件）全绿
- [x] 发布 `2026.11.18-7`（`prepare/verify 8/8 → switch → restart`，`active`、`NRestarts=0`）；飞书真机项已登记 `docs/06 §六` 待 owner 触发
- [x] 回写 `spec.md` Slice AR、`AGENTS.md §4`、`docs/11` 生命周期说明、`docs/16 §12.34`

# Slice AS — 富媒体输出与多模态输入（A4 + A8，2026-11-18）

> 目标：图片/文件/语音能作为指令进来，长回执与执行产物能作为附件出去；
> 不新增表、不改 ⑤ 的 schema。

## AS1 入站归一化（附件元数据）

- [x] `plugins/feishu/src/normalize.ts`：`content.attachments`（image/file/audio/video 元数据），`raw` 保留
- [x] `post` 取标题+正文文本并按顺序收集内嵌 `img`
- [x] 解析失败/非附件消息行为不变（既有 5 条归一化用例不回归）

## AS2 入站落盘与文本说明

- [x] `plugins/feishu/src/channel.ts`：`attachments: { dir, resource }`，`messageResource.get` 写盘
- [x] 安全文件名（basename、去控制符、80 字上限），目录 `<dir>/<msgId>/`
- [x] 文本追加附件说明（图片/文件/语音/视频），正文在前
- [x] 单附件失败不丢消息；失败只记 warn，不进正文
- [x] `scripts/lib/startup.mjs` + `scripts/serve.mjs`：`DSH_WFXM_ATTACHMENT_DIR`（默认 `<dataDir>/attachments`），storage 步建目录

## AS3 前台保留附件路径

- [x] `plugins/orchestrator/src/prompt.ts`：正文含「本地路径」时必须原样写进 `intent`
- [x] 只发附件时 `intent` 写明「查看/处理附件 `<path>`」
- [x] 规则前台/`applySupplement` 沿用文本路径（回归确认）

## AS4 出站富媒体

- [x] `plugins/feishu/src/transport.ts`：`kind:'file'` / `kind:'image'` 载荷（上传→发消息）
- [x] `text` 先发说明，回执 id 取附件消息；永久失败降级文本
- [x] `plugins/gateway/src/receipt-relay.ts`：`spill` 端口 + 阈值（0=关闭），超阈值转 `file` 载荷
- [x] `plugins/host/src/host.ts`：`SpillPort`（`<dataDir>/outbox-files`，写入前脱敏）+ 选项
- [x] `scripts/lib/startup.mjs` + `scripts/serve.mjs`：`DSH_WFXM_SPILL_CHARS`（默认 600）、`DSH_WFXM_OUTBOX_FILES`

## AS5 执行产物出站

- [x] `plugins/executor/src/executor.ts`：`[[ATTACH]] <path>`（≤3、cwd 内、≤20MB），`ExecSuccess.attachments`
- [x] 越界/缺失/超限「附件忽略：原因」写进 summary，不影响成功
- [x] `plugins/tasks/src/worker.ts`：`onArtifacts` 可选钩子（失败不影响 settle）
- [x] `plugins/host/src/host.ts`：按 live 线程入队 `task.artifact`（图片→`image`，其余 `file`，去重键 `task-artifact:<taskId>:<path>`）

## AS6 验证、发布与回写

- [x] `verify-feishu`：归一化 4 类 + 落盘/失败 + transport 上传/降级/无地址（60）
- [x] `verify-gateway`：外溢长/短/未注入 + 去重与 `receiptIdOf` 不变（121）
- [x] `verify-host`：spill 接线 + `onArtifacts` 入队且只一次（44）
- [x] `verify-executor`：标记解析/三类忽略/标记不进 summary（26）
- [x] `verify-orchestrator`：prompt 附件规则（55）
- [x] `build` / `--noEmit` / `check-style` / `verify-all` 全绿
- [x] 发布 `2026.11.18-8`（`prepare/verify → switch → restart`，`active`、`NRestarts=0`）
- [x] 回写 `spec.md` Slice AS、`AGENTS.md §4`、`docs/14 §五`、`docs/16 §12.35`、`docs/06 §六`

## AS7 A8 真机验收（2026-11-19，release `2026.11.19-2`）

- [x] 飞书真机：`a8-test.md`（62 B）→ 落盘 + 正文含本地路径，任务 `njyf7jg4s5` 用 `read` 读出标记
- [x] 飞书真机：截图（26,307 B）→ 落盘 + 任务 `gk29a4vn6u` 正确描述截图内容
- [x] 附件与配文分两条消息也能合并：附件建任务，配文作为补充指令并入同一任务
- [x] 修复 `readRoots` 未含 `/var/lib/dsh-wfxm/attachments`（此前 `read` 被拦，模型改用 `cat`）
- [x] 修复未知 `file_size` 显示「0 字节」：改用落盘实际字节数（`statSync`）
- [x] `verify-feishu` 61 例、全量 `46 passed`；发布 `2026.11.19-2` 并重启
- [x] 执行产物真机：任务 `acex6akv3n` 生成 `a4-report.txt`（28 B）→ `task.artifact` `sent`（`kind=file`）
- [x] 修复执行器提示词未告知 `[[ATTACH]]` 约定（发布 `2026.11.19-5`）

# Slice AT — 提醒（J5，2026-11-18，release `2026.11.18-9`）

> 目标：自然语言设提醒（一次性/每天/每周），到点推到原线程；提醒不是任务，不执行任何动作。

## AT1 `@dsh-wfxm/reminder`

- [x] `reminders` 表 + `schema_migrations(module='reminder', v1)`，索引 `(status,due_at)` / `(thread_id,status,due_at)`
- [x] store：`create` / `get` / `listPending` / `listDue` / `markFired` / `cancel` / `close`
- [x] `nextDueAt`（周期推进、错过多次只跳第一个未来时刻）+ `formatReminderDue`（Asia/Shanghai）
- [x] `createReminderPort` / `toReminderView`（`when` / `repeatLabel` 预格式化）

## AT2 前台识别

- [x] `decision.ts`：`remind` / `reminders` / `cancel_remind`，未来（≤366 天）、≤200 字、repeat 白名单、index 1..20
- [x] `prompt.ts`：当前时间 + 待触发列表（仅端口存在时展示三种动作）
- [x] `foreground.ts`：端口写库/列表/取消，端口缺失或写入失败可见降级

## AT3 host 到点投递

- [x] `WfxmHostOptions.reminders` + `HostPumpReport.reminders`
- [x] pump：`due_at <= now` → `say`（幂等键 `reminder:<id>:<dueAt>`）→ 一次性/周期推进
- [x] 目标线程不可寻址：不猜 chat、结束并 warn
- [x] 三种 outcome 的确认文案（host 生成，模型不编造时间）

## AT4 运行接线

- [x] `scripts/serve.mjs`：创建 store、注入 host 与 `foregroundFactory`、`shutdown` 关闭
- [x] `scripts/lib/startup.mjs`：`createReminderStore` 进 `REQUIRED_MODULES`
- [x] `modules` 启动日志含 `reminders: "on"`

## AT5 验证

- [x] 新增 `verify-reminder`（14）：迁移幂等、CRUD、周期推进、时区展示
- [x] `verify-host`（46）：到点只投一次 + 周期推进 + 缺失线程丢弃
- [x] `verify-orchestrator`（65）：决策校验、prompt、创建/列表/取消端到端
- [x] `verify-release`：依赖硬链接数 13 → 14
- [x] `build` / `--noEmit` / `check-style 173 files` / `verify-all 42 passed`（preimages 为 root 下既有 advisory）

## AT6 发布与回写

- [x] 发布 `2026.11.18-9`（`prepare/verify 8/8 → switch → restart`，`active`、`NRestarts=0`）
- [x] 生产库已有 `reminders` 表与 `schema_migrations(module='reminder', v1)`，日志 `reminders: "on"`
- [x] 回写 `spec.md` Slice AT、`.trae/specs/add-reminder/*`、`AGENTS.md §4`、`docs/08 J5`、`docs/09 J5`、`docs/15 §四`、`docs/16 §12.36`、`docs/06 §六`

# Slice AU — 邮件读取与搜索（J1，2026-11-18，release `2026.11.18-10`）

> 背景：部署机无 pnpm/npm/corepack，`dsh-email` 无法安装；改为自建只读 IMAP 端口。

## AU1 `@dsh-wfxm/mail` 后端

- [x] `scripts/mail-query.py`：IMAP 只读（`select readonly`）、stdin JSON、search/read、MIME 解码、HTML 去标签、`--self-test`（10 项）
- [x] `config.ts`：`~/.dsh/integrations/dsh-mail/config.json` + `secretRef`，`DSH_WFXM_MAIL_*` 覆盖
- [x] `query.ts`：spawn/超时/JSON 解析/错误分类（config/auth/network/timeout/protocol/parse/unavailable）

## AU2 工具与插件

- [x] `mail_search` / `mail_read`（R0，参数校验、正文截断、附件只列清单）
- [x] `plugin.ts` 形态：`apply` / `name` / `inject` + `cordis.patch.yml`

## AU3 运行接线

- [x] `scripts/install-mail-profile.mjs`（幂等挂 headless profile，已实际执行）
- [x] `dsh --profile headless --dump-config` 可见 `@dsh-wfxm/mail`
- [x] `docs/16 §12.37` 配置与安装步骤（含 QQ 授权码获取）

## AU4 验证

- [x] `verify-mail`（18）：配置/参数/错误分类/工具注册/未配置降级/Python 自测/profile 安装幂等
- [x] `verify-all` 注册 mail 套件；`verify-release` 依赖链接断言改为动态
- [x] `build` / `--noEmit` / `check-style 179 files` / `verify-all 43 passed`（preimages advisory）

## AU5 发布与回写

- [x] 发布 `2026.11.18-10`（`prepare/verify 8/8 → switch → restart`，`active`、`NRestarts=0`）
- [x] 回写 `spec.md` Slice AU、`.trae/specs/add-mail-read/*`、`AGENTS.md §4`、`docs/08 J1`、`docs/09 J1`、`docs/12`、`docs/16 §12.37`、`docs/06 §六`

# Slice AV — 变更生命周期与半应用回滚（⑦ changes，2026-11-18，release `2026.11.18-11`）

## AV1 `@dsh-wfxm/changes`

- [x] `changes` 表（`ops.sqlite`，`schema_migrations(module='changes', v1)`），`ux_changes_task` / `ix_changes_status`
- [x] 状态机：`applying → applied → verified → kept`、`applying → failed`、`applying|failed → rolled_back`
- [x] `begin`（按 `task_id` 幂等）/ `markApplied` / `markVerified` / `keep` / `markFailed` /
      `claimRollback` / `markRolledBack` / `markRollbackFailed` / `get` / `getByTask` /
      `listHalfApplied` / `listRecent` / `close`；非法迁移返回 `invalid-transition`
- [x] `createTaskChangePort`（⑤ 的结构契约，AR32）

## AV2 ⑤ 接入

- [x] `TaskWorkerOptions.changes`、`WorkerSkipReason='change-refused'`
- [x] R2/R3 执行前 `begin`（R3 带 `snapshotId`），成功 `keep`，终态失败 `markFailed`，
      可重试失败保持 `applying`；`begin` 失败 → `failed(change-record-failed)`，不执行
- [x] 端口未注入时行为与切片前一致

## AV3 host 启动恢复

- [x] `WfxmHostOptions.changes` / `restoreWorkspace`，`host.recoverChanges()`
- [x] 已成功任务补账 `kept`；其余 `claimRollback` → 快照还原或前镜像回滚；失败留痕 + `warn`
- [x] `serve` 第 6 步：`recoverChanges()` 先于 `worker.recover()`；日志 `recovery:changes`

## AV4 验证

- [x] `verify-changes`（11）
- [x] `verify-tasks`（113，新增 6 例）/ `verify-host`（52，新增 6 例）；`verify-all` 注册 changes 套件
- [x] `build` / `--noEmit` / `check-style 183 files` / `verify-all 44 passed`（preimages advisory）

## AV5 发布与回写

- [x] 发布 `2026.11.18-11`（`prepare/verify 8/8 → switch → restart`，`active`、`NRestarts=0`）
- [x] 回写 `spec.md` Slice AV、`.trae/specs/add-change-lifecycle/*`、`AGENTS.md §4`、
      `docs/11 §5.4`、`docs/15 §模块 ⑦`、`docs/16 §12.38`、`docs/06 §六`
- [x] 真机演练（2026-11-19 维护窗口）：注入 `applying` + 前镜像 → 启动回滚
      `rolledBack:1`，文件 `MUTATED`→`ORIGINAL`，台账 `rolled_back/done`；清理后 `0/0/0`

# Slice AW–AY — 检索自检 / 项目级授权 / IM 全局停止（2026-11-18，release `2026.11.18-12`）

## AW J6 部署级检索自检

- [x] `scripts/verify-search.mjs`：dump-config 断言搜索/抓取插件与 provider；`--live` 可选真机
- [x] 注册 `verify-all`
- [x] 文档：`docs/09 J6`、`docs/06 §六`

## AX E3 项目级授权

- [x] `config/project-tools.json` + `policy.yaml` 的 `projectToolsFile`
- [x] governance 加载白名单与 `evaluate(..., projectId)` → `deny(project-tool)`
- [x] `tools/pre-execute` 读 `DSH_WFXM_PROJECT_ID`；executor spawn 注入
- [x] `verify-project-tools`（8）/ `verify-executor`（+1）
- [x] 文档：`docs/11 §5.2`、`docs/16 §12.39`、`AGENTS.md`、`docs/09 E3`

## AY H4 IM 全局停止

- [x] gateway：`halt` / `resume_all` / `status_all`、中英别名、无锚点、`GlobalControlPort`
- [x] host：`haltFile`、`halt/resume/isHalted`、`skipped='halted'`、提醒跳过、停止期对话拦截
- [x] serve：传 `haltFile`、启动日志 `halt`
- [x] `verify-gateway`（+3）/ `verify-host`（+3）/ `verify-serve`（+1）
- [x] 文档：`docs/11 §5.3`、`docs/16 §12.40`、`AGENTS.md`、`docs/09 H4`

## 发布

- [x] `build` / `--noEmit` / `check-style` / `verify-all 46 passed`
- [x] 发布 `2026.11.18-12`、重启、勾选 checklist、提交推送
- [x] 飞书真机验收（停 → 拦消息 → 恢复）；修复停止文件路径与 `status_all` 文案，发布 `2026.11.18-14`

## AZ H6 / AR37 授权唤醒闭环

- [x] ① `wake.ts` / `ingest.ts`：唤醒 scope 带 `domain = task.projectId`
- [x] ③ `grants/store.ts`：扫描读该 actor 全部授权，撤销回报 `revoked`
- [x] ③ `grants-admin.ts` / `index.ts`：发放省略 `policyVersion` 时落当前策略版本
- [x] host `ports.ts` / `host.ts`：注入 `policyVersion`，复验透传 `domain`
- [x] `serve.mjs`：启动读取 `policy.yaml` 版本并输出 `policy {"version":1}`
- [x] `verify-grants`（30）/ `verify-grants-admin`（21）/ `verify-gateway`（124）/ `verify-host`（57）
- [x] 门禁：`build` / `--noEmit` / `check-style 185 files` / `verify-all 46 passed`
- [x] 发布 `2026.11.19-1`、重启、`[startup] 8/8`
- [x] 文档：`docs/09 H6`、`docs/11 §九 AR37`、`docs/15 §三`、`AGENTS.md Slice AZ`

## BA H3 审计查询面

- [x] ④ `audit/store.ts`：`query({actorId,action,target,from,to,limit,beforeSeq})` + `verifyChain()`
- [x] ④ `audit/verify.ts`：抽出 `verifyAuditRows()`，CLI 与在线查询共用同一套重算逻辑
- [x] 新增 `web/audit-admin.ts`：`GET /admin/audit`（JSON / HTML 外壳）、`?verify=1`、只读 405
- [x] `governance/index.ts`：与授予管理面共用 `AdminAuthorizer`，经 `ctx.effect` 挂 3 条路由
- [x] `verify-audit-admin` 10 例；`verify-grants-admin` 21 例（挂载数 2→3）
- [x] 门禁：`build` / `--noEmit` / `check-style 187 files` / `verify-all 47 passed`
- [x] 生产库链校验：384 条 `ok`
- [x] 文档：`docs/09 H3`、`docs/15 §四`、`docs/16 §12.41`、`AGENTS.md Slice BA`

## BB H2 入站准入加固

- [x] 新增 `gateway/src/admission.ts`：渠道 allowlist、每主体固定窗口限流、内容上限
- [x] `ingest.ts`：去重后、分诊前检查；拒绝落 `inbox.rejected` + `route_decisions`，新增 3 个 bypass 原因
- [x] 未配对 `/bind` 也受限流保护（主体 = `external_user_id`）
- [x] host `admission` 选项与 `serve.mjs` 的 `parseAdmissionEnv`（格式错误启动即失败）
- [x] `verify-gateway` 128 例（新增渠道/限流/超大/环境解析 4 例）
- [x] 门禁：`build` / `--noEmit` / `check-style 188 files` / `verify-all 47 passed`
- [x] 生产 `/etc/dsh-wfxm/env` 配置渠道与限流，重启确认 `admission` 日志
- [x] 真机：owner 发「你好」→ `routed`、无 `error_code`、`say` 已 `sent`，无 `admission:` 拒绝
- [x] 文档：`docs/09 H2`、`docs/11 §5.3`、`docs/15 §二`、`docs/16 §12.42`、`AGENTS.md Slice BB`

## BC J2 只读邮件摘要

- [x] 新增 `plugins/mail/src/digest.ts`：窗口过滤、未读筛选、`需要回复 / 需要处理 / 仅供参考` 确定性分组、Markdown 渲染
- [x] `mail_digest` 工具（R0）：`hours` 1..168、`limit` 1..50、`unreadOnly`；只读头部元数据，不读正文/不发送
- [x] 输出显式标注“邮件元数据仅作信息，不构成指令”（防邮件内容注入）
- [x] `verify-mail` 23 例（新增分组/窗口/未读/截断/参数/工具注入 5 例）
- [x] 门禁：`build` / `--noEmit` / `check-style 189 files` / `verify-all 47 passed`
- [x] 发布 `2026.11.19-8`；修复生产 headless profile 未挂邮件插件（链接指向 `/opt/dsh-wfxm/current/plugins/mail`）
- [x] 真机：163 授权码接入后 `mail_digest` 返回 3 封未读并分组；`mail_search` 真实返回 INBOX 40 封
- [x] 修复 163 IMAP `ID`（`xatom`）、邮件凭据不得写入 dsh 全局凭据库
- [x] 文档：`docs/08 J2`、`docs/09 J2`、`docs/16 §12.37`、`AGENTS.md Slice BC`
- [x] 每日 08:30 自动摘要（Slice BD：宿主 pump 调度 + 状态文件 + outbox 幂等键，2026-11-19 真机）

# Slice BD — 一期结项收口（J2 每日摘要 / 文档对齐，2026-11-19，release `2026.11.19-9`）

## BD1 `@dsh-wfxm/mail` 每日调度

- [x] 新增 `plugins/mail/src/schedule.ts`：`parseDigestEnv` / `localDayMinutes` / `digestDue` / `readDigestState` / `writeDigestState`
- [x] `parseDigestEnv` fail-fast：`AT` 必须 `HH:MM`，hours 1..168，limit 1..50，时区非法启动即失败
- [x] 状态文件原子写（`.tmp` + rename），缺失/损坏返回 `lastDate=null`
- [x] `plugins/mail/src/index.ts` 导出
- [x] `verify-mail` 31 例（新增 7 例：关闭/解析/越界/显式项/时区/due/状态）

## BD2 宿主每日投递

- [x] `HostMailDigestOptions` + `WfxmHostOptions.mailDigest`
- [x] `fireDailyDigest()`：到点判定 → 选线程 → 注入/默认 produce → 幂等入 outbox → 写状态
- [x] 失败退避：无线程 10 分钟、IMAP 失败 15 分钟，均不写状态
- [x] `HostPumpReport.digest`
- [x] `verify-host` 62 例（新增 5 例：未到点/到点一次/无线程/停止/失败退避）

## BD3 入口接线

- [x] `scripts/serve.mjs`：`parseDigestEnv` + `mailDigest` + `log('digest', …)`
- [x] `verify-serve` 14 例（新增 1 例：合法配置出现在日志、非法时间拒绝启动）

## BD4 文档对齐

- [x] `docs/09`：B2 / B4 / C6 / I3 / O3 / J2 行按代码现状改写
- [x] `docs/09` 新增 §九「一期结项清单」（MVP 37 + 上线门槛 + 一期外）
- [x] `docs/08` J2 行同步
- [x] `docs/16` 新增 §12.43
- [x] `AGENTS.md` Slice BD
- [x] `tasks.md` 本切片

## BD5 门禁与发布

- [x] `node scripts/build.mjs`
- [x] `node scripts/build.mjs --noEmit`
- [x] `node scripts/check-style.mjs`
- [x] `node scripts/verify-all.mjs`（0 failed）
- [x] 发布 `2026.11.19-9`、重启、`[startup] 8/8` + `digest` 日志

## BD6 真机验收

- [x] `/etc/dsh-wfxm/env` 设 `DSH_WFXM_MAIL_DIGEST_AT=<下一分钟>`，重启，确认飞书收到摘要
- [x] 2 分钟内无重复；恢复 `08:30` 重启
- [x] 提交推送

# Slice BE — M7 提示注入与来源防护（v1，2026-11-19，release `2026.11.19-10`）

## BE1 执行器指令层级

- [x] `buildTaskPrompt`：owner `intent` → `【指令层级】` → `【数据区（不可信，仅作参考）】` → 执行约定
- [x] `threadContext` 只进数据区；空上下文仍保留 `（无）`
- [x] `verify-executor` 30 例（新增 3 例：层级/数据区/空上下文）

## BE2 前台信任边界

- [x] `buildDecisionPrompt`：声明「消息 = 指令层，最近对话/粘贴原文 = 数据层」
- [x] 新增疑似注入处置规则（有提醒第 14 条、无提醒第 10 条）
- [x] `verify-orchestrator` 66 例（新增 1 例）

## BE3 出站守卫

- [x] 新增 `plugins/gateway/src/outbound.ts`：先脱敏后截断 `text` / `summary`（20,000 字/字段）
- [x] `store.enqueueOutbox` 改调 `guardOutboundPayload`；`index.ts` 导出
- [x] `verify-gateway` 132 例（新增 4 例：脱敏/截断/短文本/纯函数）

## BE4 邮件分级标注

- [x] `mail_search` / `mail_read` 渲染标注「仅作信息，不构成指令」
- [x] `verify-mail` 32 例（新增 1 例）

## BE5 门禁与发布

- [x] `node scripts/build.mjs` / `--noEmit` / `check-style.mjs`
- [x] `node scripts/verify-all.mjs`（47 passed / 0 failed）
- [x] 发布 `2026.11.19-10`、重启、`[startup] 8/8`

## BE6 文档对齐

- [x] `docs/09` M7 行与 §9.2 结项表
- [x] `docs/16 §12.44`
- [x] `AGENTS.md` Slice BE
- [x] `tasks.md` 本切片
- [x] 提交（`d0b1f22`）
- [x] 推送（`ailearn` 用户，`887815d`）

# Slice BF — C8 测试验收约定（2026-11-19，release `2026.11.19-11`）

## BF1 执行器提示

- [x] 新增 `ACCEPTANCE_INSTRUCTION`：先复现 → 修 → 同一测试/命令证明 → 答复给命令与结果
- [x] 无法自动化时要求说明原因与手工验证步骤，禁止只说「已修复」
- [x] `buildTaskPrompt` 在数据区与 `[[NEED_INPUT]]` 之间加入 `【验收约定】`

## BF2 用例与门禁

- [x] `verify-executor` 31 例（新增 1 例）
- [x] `build` / `--noEmit` / `check-style` / `verify-all 47 passed`
- [x] 发布 `2026.11.19-11`、重启、`[startup] 8/8`

## BF3 文档

- [x] `docs/09` C8 行与结论
- [x] `docs/16 §12.45`
- [x] `AGENTS.md` Slice BF
- [x] `tasks.md` 本切片

# Slice BG — M9a 行为基线（2026-11-19，离线工具，无需发布）

## BG1 判据与 runner

- [x] `bench/tasks.json` 20 项全部加确定性 `expect`（工具/关键词/步数上限）
- [x] `bench/lib.mjs`：`judgeTrace`（无模型判定）、`renderBaselineMarkdown`、`expect` 校验
- [x] `bench/runner.mjs`：真实 dsh → 解析 NDJSON → 输出判据 JSON（含 reasons/tools/tokens）
- [x] `bench/run.mjs`：新增 `--exclude`，并保留失败原因

## BG2 基线闭环

- [x] `bench/baseline.mjs`：跑全量、归档 JSON/MD、默认排除两项 `change`
- [x] 首轮真实基线：16/18（平均 5.78 步，覆盖 100%）
- [x] 可跟踪摘要：`bench/baselines/2026-11-19.md`
- [x] `bench/verify` 18 例；`verify-all 47 passed / 0 failed`

## BG3 文档

- [x] `docs/09` M9 行、§9.2 与结论
- [x] `docs/12` A6 进度
- [x] `docs/16 §12.46`
- [x] `AGENTS.md` Slice BG
- [x] `tasks.md` 本切片

# Slice BH — M9b 多轮基线与回归门禁（2026-11-19，离线工具，无需发布）

## BH1 多轮聚合

- [x] `bench/lib.mjs`：`aggregateRounds` / `renderAggregateMarkdown` / `compareBaseline` / `renderRegressMarkdown`
- [x] `bench/thresholds.json`：整体通过率、覆盖率、任务坍塌、最小轮数
- [x] `bench/baseline.mjs --rounds N` + `--write-reference`
- [x] `bench/regress.mjs`：默认 advisory，`--enforce` 退化退出 3

## BH2 用例

- [x] `bench/verify` 22 例（聚合 / 阈值 / 回归 / CLI）
- [x] `scripts/verify-all.mjs` 全绿

## BH3 真实基线与文档

- [x] 3 轮真实基线（44/54，81.5%）并生成 `bench/baselines/reference.json`
- [x] `docs/09` M9 行与 §9.2
- [x] `docs/12` A6 进度
- [x] `docs/16 §12.47`
- [x] `AGENTS.md` Slice BH
- [x] `tasks.md` 本切片

# Slice BI — A8 语音转写（2026-11-19，release `2026.11.19-12`）

## BI1 ASR 客户端

- [x] `plugins/feishu/src/asr.ts`：OpenAI 兼容 `/audio/transcriptions`，手写 multipart
- [x] 大小上限、超时、错误脱敏（不含 key / 音频内容）、响应 `text` 校验
- [x] `index.ts` 导出 `createOpenAiTranscriber` 与类型

## BI2 入站接线

- [x] `stageAttachments` 对 `audio` 可选 `transcribe`；成功 `[语音转写]`，空/失败/未配置分别提示
- [x] 转写上限 10,000 字；失败不丢消息（AR13）
- [x] `scripts/lib/startup.mjs`：`ASR_BASE_URL` + `ASR_API_KEY_FILE`（密钥不进 env）+ 模型/语言/超时/大小
- [x] `scripts/serve.mjs`：构造 transcriber 并传入 channel，启动日志 `asr …`
- [x] `deploy/systemd/dsh-wfxm.env.example` 注释示例

## BI3 用例与门禁

- [x] `verify-feishu` 65 例（新增 4 例：转写成功/空失败未配置/客户端 multipart/超限）
- [x] `verify-serve` 14 例（ASR 配置默认关、半配置拒绝）
- [x] `build` / `--noEmit` / `check-style` / `verify-all 47 passed`

## BI4 发布与文档

- [x] 发布 `2026.11.19-12`、重启、`[startup] 8/8`、`asr disabled`
- [x] `docs/09` A8 行
- [x] `docs/14 §3.1`
- [x] `docs/16 §12.48`
- [x] `AGENTS.md` Slice BI
- [x] `tasks.md` 本切片

# Slice BJ — A8 零后端语音引导（2026-11-19，release `2026.11.19-13`）

## BJ1 决策与文案

- [x] 确认飞书客户端转文字不通过事件暴露（仅 `file_key` + `duration`）
- [x] 确认飞书服务端 ASR 免费版不支持、需 PCM 转码，不作默认路径
- [x] 未配置/转写为空/转写失败统一引导：手机输入法语音输入，或长按语音「转文字」
- [x] 本地路径只留在 `attachments` JSON，不在回复里刷屏

## BJ2 用例与发布

- [x] `verify-feishu` 65 例通过
- [x] 发布 `2026.11.19-13`、重启、`[startup] 8/8`
- [x] `docs/09` A8 / `docs/14 §3.1` / `docs/16 §12.48` / `AGENTS.md` 对齐
- [x] 提交推送（ailearn）

# Slice BK — I5 成本可见（2026-11-19，release `2026.11.19-14`）

## BK1 采集与入库

- [x] 执行器解析 `status/step_end` usage，outcome 返回 `{inputTokens,outputTokens,costUsd}`
- [x] `DshExecutorOptions.pricing` + 组合根 `DSH_WFXM_PRICE_{IN,OUT}_USD_PER_MTOK`
- [x] tasks v9 迁移：`input_tokens` / `output_tokens` / `cost_usd`
- [x] `recordUsage` 累加；worker 在成功/失败/待补充/重试的 settle 路径都调用
- [x] `Task` 暴露三列；`ExecUsage` 端口类型

## BK2 展示

- [x] 任务日报表头：有金额显示 `费用 $x`，无单价时显示 `tokens a/b`
- [x] `deploy/systemd/dsh-wfxm.env.example` 价格注释

## BK3 用例与发布

- [x] `verify-executor 32`（两步求和 + 计价）
- [x] `verify-tasks 115`（v9 迁移 / 累加 / worker settle）
- [x] `verify-digest 14`（费用与 token 表头）
- [x] `verify-serve 14`（价格配置与非法值）
- [x] `verify-all 47 passed / 0 failed`
- [x] 发布 `2026.11.19-14`、重启、`schema_migrations(tasks)=9`
- [x] 文档：`docs/09` I5 / `docs/15` v9 / `docs/16 §12.49` / `AGENTS.md`
- [x] 提交推送（ailearn）
