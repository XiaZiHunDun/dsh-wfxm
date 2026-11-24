# dsh-wfxm — 基于 DeepSeek Harness 的服务器 AI 管家

> **状态**：第一阶段已收口（2026-11-24）。一期 MVP 37/37、上线门槛 7/7；二期 v1 四片 + v2 两片完成，
> 生产运行 `2026.11.24-3`（飞书主通道）。范围与延后项见 [docs/20](docs/20-二期范围.md)。
> **入口**：AI 编码工具先读 [AGENTS.md](AGENTS.md)；没有聊天记录的新会话先读 [docs/00-接续指南.md](docs/00-接续指南.md)；文档导航见 [docs/README.md](docs/README.md)。

## 一句话

把 WFXM（Butler v5）的治理资产与中文产品语义，迁移到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）之上，
通过飞书驱动的、面向自有服务器的、多项目并行开发 + 运维 + 生活管家。

**做**：dsh 当执行引擎，飞书长连接为主通道（微信仅 P1 兜底），治理与产品语义写成 dsh 插件。
**不做**：fork dsh / dsh-im；不做 sidecar 过渡；不重写 iLink 协议层。

## 仓库结构

```
dsh-wfxm/
├── AGENTS.md               AI 编码入口：必读表、硬约束、逐片变更记录
├── README.md               本文件
├── spec.md / tasks.md      逐片（Slice）设计与验收记录
├── docs/                   01–20 设计、架构、契约与运维文档（索引见 docs/README.md）
├── plugins/                16 个插件（TypeScript，各自 tsconfig + 独立验证套件）
│   ├── gateway/            ① 入站、配对、去重、路由决策
│   ├── orchestrator/       ⑤ 前台决策（reply / task / ask / approval）
│   ├── tasks/              ⑤ 任务、隔离、合并、irreversible 检测
│   ├── host/               dsh 运行时接线与前台循环
│   ├── governance/         ②③④ 判级 / 审批 / 审计（哈希链）
│   ├── executor/           执行器提示与指令层级
│   ├── feishu/             飞书通道（长连接、卡片）
│   ├── knowledge/          ⑥ 记忆与项目注册
│   ├── svcops/             ⑦ 服务/端口/磁盘巡检
│   ├── snapshot/           前置快照
│   ├── notify/             ntfy 通道
│   ├── redact/             出口脱敏
│   ├── reminder/           提醒
│   ├── calendar/           服务器自管日程 + 会前提醒
│   ├── mail/               邮件检索/摘要/发送
│   └── changes/            变更记录
├── scripts/                构建、验证、发布、备份、项目与隔离运维
├── bench/                  评测基线与回归
├── config/                 运行配置（项目白名单等）
└── deploy/                 systemd / polkit / sudoers / journald
```

## 常用命令

```bash
# 构建与类型检查（本机依赖已就绪，不重复跑 pnpm）
node scripts/build.mjs
node scripts/build.mjs --noEmit

# 全量验证（51 套件；preimages 为 advisory）
node scripts/check-style.mjs
node scripts/verify-all.mjs

# 本地运行
node scripts/serve.mjs

# 发布（生产）
node scripts/release.mjs prepare --version <ver>
node scripts/release.mjs verify  --version <ver>
node scripts/release.mjs switch  --version <ver>
systemctl restart dsh-wfxm

# 项目登记（自动推导 prepareCmd / rulesDoc）
node scripts/projects.mjs add --name <name> --root <path>
node scripts/projects.mjs list --json

# 任务隔离
node scripts/isolation.mjs status <taskId>
node scripts/isolation.mjs release <taskId> --reason abandoned

# 备份与演练
node scripts/backup.mjs
node scripts/restore-drill.mjs
```

> 生产上以 `dshwfxm` 用户执行，并在命令前加 `DSH_WFXM_DB=/var/lib/dsh-wfxm/ops.sqlite`；
> 完整步骤见 [16 §七](docs/16-部署与运行.md)。

## 文档导航

| 目的地 | 文档 |
|---|---|
| 产品该有什么 | [08-产品能力构想](docs/08-产品能力构想.md) |
| 实现判定 / 一期结项 | [09-能力对照与实现路径](docs/09-能力对照与实现路径.md) |
| 架构与不变量 | [11-架构锚定](docs/11-架构锚定.md) |
| 数据表与端口契约 | [15-数据与契约](docs/15-数据与契约.md) |
| 部署 / 发布 / 备份 / 排障 | [16-部署与运行](docs/16-部署与运行.md) |
| Agent preset / 提示 / 工具 | [17-Agent 侧设计](docs/17-Agent侧设计.md) |
| 全部文档索引 | [docs/README.md](docs/README.md) |

## 生产位置

| 路径 | 内容 |
|---|---|
| `/opt/dsh-wfxm/current` | 当前发布（`releases/` 蓝绿软链） |
| `/var/lib/dsh-wfxm/ops.sqlite` | 运行库（任务、审批、审计、日程、项目） |
| `/var/lib/dsh-wfxm/projects/` | 登记项目的工作副本与 worktree |
| `/etc/dsh-wfxm/` | 环境与凭据（`env` 为 `0640 root:dshwfxm`） |
| `/var/backups/dsh-wfxm/` | 备份归档与 `.sha256` |

迁移参考源码（只读）：`/home/ailearn/projects/WFXM`、`/home/ailearn/githubpro/deepseek-harness`、`/home/ailearn/githubpro/cordis`。

## 下一步

第一阶段（一期 + 二期 v1/v2）已收口，不设新排期。明确延后的项见 [20 §七](docs/20-二期范围.md#七度量与结项口径)：
O1 领域路由（等第二个专家）、N6 生成物治理（等 codegen 产物）、N8 迁移文件化（等下一次 schema 变更）、
微信 P1 兜底（无需求）。触发条件满足时再开片。
