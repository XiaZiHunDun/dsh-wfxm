#!/usr/bin/env bash
#
# 主机侧一次性安装（root）：系统 Node/dsh、服务用户、目录、env、systemd unit、polkit 规则。
# 与 docs/16 §三 对应。**幂等**：重复执行只补齐缺的部分。
#
#   sudo NODE_SRC=<node24目录> bash deploy/install.sh   # 安装/修复（无系统 Node 时必须给 NODE_SRC）
#   sudo DRY_RUN=1 NODE_SRC=... bash deploy/install.sh   # 只打印将执行的命令
#
# 不做的事：release 目录与软链（由 scripts/release.mjs 以普通用户完成）、
# 凭据内容的拷入（见末尾提示）、`systemctl start`（首次发布后再手动起）。
set -euo pipefail

SERVICE_USER=dshwfxm
SERVICE_GROUP=dshwfxm
DATA_DIR=/var/lib/dsh-wfxm
HOME_DIR=$DATA_DIR/home
BACKUP_DIR=/var/backups/dsh-wfxm
CONF_DIR=/etc/dsh-wfxm
CRED_DIR=$CONF_DIR/credentials
UNIT_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm.service
BACKUP_UNIT_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm-backup.service
BACKUP_TIMER_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm-backup.timer
HEALTH_UNIT_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm-health.service
HEALTH_TIMER_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm-health.timer
JOURNALD_SRC=$(cd "$(dirname "$0")" && pwd)/journald/10-dsh-wfxm.conf
ENV_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm.env.example
POLKIT_SRC=$(cd "$(dirname "$0")" && pwd)/polkit/50-dshwfxm.rules
WRAPPER_SRC=$(cd "$(dirname "$0")" && pwd)/bin/dsh-wfxm-unit-control
SUDOERS_SRC=$(cd "$(dirname "$0")" && pwd)/sudoers/dsh-wfxm-unit-control
# Root-side whitelisted unit control: the service runs with NoNewPrivileges=yes,
# so sudo can never elevate. This helper owns a root:dshwfxm socket instead.
HELPER_SRC=$(cd "$(dirname "$0")" && pwd)/bin/unit-control-server.mjs
HELPER_CLIENT_SRC=$(cd "$(dirname "$0")" && pwd)/bin/unit-control-client.mjs
HELPER_UNIT_SRC=$(cd "$(dirname "$0")" && pwd)/systemd/dsh-wfxm-unit-control.service

run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

if [ "$(id -u)" -ne 0 ] && [ "${DRY_RUN:-0}" != "1" ]; then
  echo "需要 root：sudo bash $0" >&2
  exit 1
fi
for file in "$UNIT_SRC" "$BACKUP_UNIT_SRC" "$BACKUP_TIMER_SRC" "$JOURNALD_SRC" "$ENV_SRC" "$POLKIT_SRC" "$WRAPPER_SRC" "$SUDOERS_SRC"; do
  [ -f "$file" ] || { echo "缺少 $file" >&2; exit 1; }
done

RELEASE_ROOT=/opt/dsh-wfxm
RUNTIME_PREFIX=/usr/local/lib/nodejs
# 发布目录的属主：默认是调用 sudo 的人（后续 release.mjs 以该身份写）。
# 直接以 root 执行时 SUDO_USER 为空——此时仍旧用 ailearn，否则 `/opt/dsh-wfxm`
# 变成 root 属主，ailearn 的 release verify（mkdtemp）会 EACCES。
RELEASE_OWNER=${RELEASE_OWNER:-${SUDO_USER:-}}
if [ -z "$RELEASE_OWNER" ]; then
  if id -u ailearn >/dev/null 2>&1; then RELEASE_OWNER=ailearn; else RELEASE_OWNER=root; fi
fi

# 0. 系统 Node：unit 固定 /usr/bin/node，且 ProtectHome=yes 看不到 nvm 目录。
#    没有系统 Node 时，从 NODE_SRC 复制一份（Node 24，含 bin/dsh）。
if [ -x /usr/bin/node ]; then
  echo "系统 Node 已存在：$(/usr/bin/node -v)"
else
  if [ -z "${NODE_SRC:-}" ] || [ ! -x "$NODE_SRC/bin/node" ]; then
    cat >&2 <<EOF
缺少 /usr/bin/node。请用 NODE_SRC 指向一个 Node 24 安装目录（含 bin/node 与 bin/dsh）：
  sudo NODE_SRC=/home/ailearn/.nvm/versions/node/v24.11.0 bash $0
EOF
    exit 1
  fi
  NODE_DEST=$RUNTIME_PREFIX/$(basename "$NODE_SRC")
  if [ -x "$NODE_DEST/bin/node" ]; then
    echo "$NODE_DEST 已存在"
  else
    run install -d -m 0755 "$RUNTIME_PREFIX"
    run cp -a "$NODE_SRC" "$NODE_DEST"
  fi
  run ln -sfn "$NODE_DEST/bin/node" /usr/bin/node
  if [ -x "$NODE_SRC/bin/dsh" ]; then
    run ln -sfn "$NODE_DEST/bin/dsh" /usr/local/bin/dsh
  else
    echo "警告：$NODE_SRC/bin/dsh 不存在；DSH_WFXM_DSH_BIN 指向的二进制需另行安装" >&2
  fi
fi

# 1. 系统用户：无登录 shell、无附加组（docker 组等价 root，绝不加入）。
if getent group "$SERVICE_GROUP" >/dev/null; then
  echo "group $SERVICE_GROUP 已存在"
else
  run groupadd --system "$SERVICE_GROUP"
fi
if getent passwd "$SERVICE_USER" >/dev/null; then
  echo "user $SERVICE_USER 已存在"
else
  run mkdir -p "$DATA_DIR"
  run useradd --system --gid "$SERVICE_GROUP" --home-dir "$HOME_DIR" \
    --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# svc_logs 需要读 journal：只加 systemd-journal（读日志），不加 adm/docker/sudo。
# 改组后要 restart 服务才对运行进程生效（补充组在 exec 时确定）。
if getent group systemd-journal >/dev/null; then
  run usermod -aG systemd-journal "$SERVICE_USER"
else
  echo "缺少 systemd-journal 组，svc_logs 将不可用（journalctl 会被拒）"
fi

# 2. 目录与权限（unit 的 ReadWritePaths 只有数据与备份两处）。
run install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR"
run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$HOME_DIR"
run install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$BACKUP_DIR"
run install -d -m 0750 -o root -g "$SERVICE_GROUP" "$CONF_DIR"
run install -d -m 0750 -o root -g "$SERVICE_GROUP" "$CRED_DIR"

# 3. env：只在缺失时写入，绝不覆盖 owner 已改过的配置。
if [ -f "$CONF_DIR/env" ]; then
  echo "$CONF_DIR/env 已存在，保持不变"
else
  run install -m 0640 -o root -g "$SERVICE_GROUP" "$ENV_SRC" "$CONF_DIR/env"
fi

# 4. unit、polkit 规则与受控 unit wrapper（内容变更时直接覆盖，全部由本仓维护）。
#    rules.d 在部分发行版上默认不存在，先补目录（polkitd 只读这里）。
#    polkit 0.105（本机 Ubuntu 22.04）不读 JS 规则，真正生效的是 wrapper + sudoers。
run install -d -m 0755 -o root -g root /etc/polkit-1/rules.d
run install -m 0644 -o root -g root "$UNIT_SRC" /etc/systemd/system/dsh-wfxm.service
run install -m 0644 -o root -g root "$BACKUP_UNIT_SRC" /etc/systemd/system/dsh-wfxm-backup.service
run install -m 0644 -o root -g root "$BACKUP_TIMER_SRC" /etc/systemd/system/dsh-wfxm-backup.timer
run install -m 0644 -o root -g root "$HEALTH_UNIT_SRC" /etc/systemd/system/dsh-wfxm-health.service
run install -m 0644 -o root -g root "$HEALTH_TIMER_SRC" /etc/systemd/system/dsh-wfxm-health.timer
run install -m 0644 -o root -g root "$POLKIT_SRC" /etc/polkit-1/rules.d/50-dshwfxm.rules
run install -m 0755 -o root -g root "$WRAPPER_SRC" /usr/local/sbin/dsh-wfxm-unit-control
# Root-side helper (preferred path; works under NoNewPrivileges).
run install -d -m 0755 -o root -g root /usr/local/lib/dsh-wfxm
run install -m 0755 -o root -g root "$HELPER_SRC" /usr/local/lib/dsh-wfxm/unit-control-server.mjs
run install -m 0755 -o root -g root "$HELPER_CLIENT_SRC" /usr/local/sbin/dsh-wfxm-unit-client
run install -m 0644 -o root -g root "$HELPER_UNIT_SRC" /etc/systemd/system/dsh-wfxm-unit-control.service
if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '+ %s\n' "install -m 0440 $SUDOERS_SRC /etc/sudoers.d/dsh-wfxm-unit-control（写前 visudo -cf 预检）"
else
  sudoers_tmp=$(mktemp)
  install -m 0440 -o root -g root "$SUDOERS_SRC" "$sudoers_tmp"
  if ! visudo -cf "$sudoers_tmp" >/dev/null; then
    rm -f "$sudoers_tmp"
    echo "sudoers 片段校验失败，未安装（避免 sudo 全局不可用）" >&2
    exit 1
  fi
  install -m 0440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/dsh-wfxm-unit-control
  rm -f "$sudoers_tmp"
fi
run systemctl daemon-reload
run systemctl enable dsh-wfxm-unit-control.service

# journald 上限只在内容变化时写入并重启，避免每次 install 都清空日志缓冲。
JOURNALD_DEST=/etc/systemd/journald.conf.d/10-dsh-wfxm.conf
journald_changed=0
if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '+ %s\n' "install -d -m 0755 /etc/systemd/journald.conf.d"
  printf '+ %s\n' "install -m 0644 $JOURNALD_SRC $JOURNALD_DEST（变化时）&& systemctl restart systemd-journald"
else
  install -d -m 0755 -o root -g root /etc/systemd/journald.conf.d
  if [ -f "$JOURNALD_DEST" ] && cmp -s "$JOURNALD_SRC" "$JOURNALD_DEST"; then
    echo "$JOURNALD_DEST 未变化"
  else
    install -m 0644 -o root -g root "$JOURNALD_SRC" "$JOURNALD_DEST"
    journald_changed=1
  fi
fi
if [ "$journald_changed" = "1" ]; then
  run systemctl restart systemd-journald
fi

# 定时备份：只 enable timer，不 --now——安装不应立刻压一次备份。
run systemctl enable dsh-wfxm-backup.timer
# 健康告警：2 分钟一次；服务正常时脚本直接退出，不发消息。
run systemctl enable dsh-wfxm-health.timer

# 5. 发布根目录：属主是调用 sudo 的人，服务只读（ProtectSystem=strict）。
run install -d -m 0755 -o "$RELEASE_OWNER" -g "$RELEASE_OWNER" "$RELEASE_ROOT"

# 6. 自检提示（只报告，不代替决定）。
echo
echo "已安装：user=$SERVICE_USER data=$DATA_DIR conf=$CONF_DIR release=$RELEASE_ROOT($RELEASE_OWNER)"
/usr/bin/node -v >/dev/null 2>&1 && echo "node: $(/usr/bin/node -v) ($(command -v dsh || echo 'dsh 未就位'))" \
  || echo "警告：/usr/bin/node 仍不可用；unit 的 ExecStart 会失败"
[ -d /opt/dsh-wfxm/current ] || echo "提示：/opt/dsh-wfxm/current 尚未发布；先跑 release.mjs 再 systemctl start dsh-wfxm"
[ -f "$CRED_DIR/feishu.json" ] && [ -f "$CRED_DIR/credentials.yaml" ] \
  || echo "提示：凭据未就位。把 \$HOME/.dsh/integrations/dsh-feishu/config.json 与 \$HOME/.dsh/.credentials.yaml 拷到 $CRED_DIR（root:$SERVICE_GROUP 0640）"
echo "下一步：install -m 0640 -o root -g $SERVICE_GROUP <凭据> $CRED_DIR/ && systemctl enable --now dsh-wfxm"
echo "定时备份：已 enable dsh-wfxm-backup.timer（每日 03:30 左右，Persistent 补跑）。"
echo "  立即备份一次：systemctl start dsh-wfxm-backup.service"
echo "  启动定时器：systemctl start dsh-wfxm-backup.timer"
