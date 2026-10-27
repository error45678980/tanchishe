#!/usr/bin/env bash
#
# 贪吃蛇 · 一键部署 / 发版脚本
# ---------------------------------------------------------------
# 适用：Ubuntu 20.04 / 22.04 / 24.04（Debian 系），root 执行
# 用法：
#   首次部署   bash deploy.sh
#   之后发版   bash deploy.sh --update     （跳过系统安装，只拉代码重建）
#   只看状态   bash deploy.sh --check      （不改动任何东西）
#
# 这台服务器的实际布局（脚本已对齐）：
#   代码   /home/admin/tanchishe
#   用户   admin（pm2 守护进程也跑在 admin 名下）
#   进程   pm2 应用名 tanchishe，fork 单实例，端口 3000
#   自启   systemd 的 pm2-admin.service
#   入口   nginx 80 → 127.0.0.1:3000
# ---------------------------------------------------------------
set -euo pipefail

REPO_URL="https://github.com/error45678980/tanchishe.git"
APP_DIR="/home/admin/tanchishe"
APP_USER="admin"
APP_NAME="tanchishe"
PORT=3000
SWAP_SIZE="2G"

MODE="deploy"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --check)  MODE="check" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf '未知参数：%s（试试 --help）\n' "$arg" >&2; exit 1 ;;
  esac
done

# ---------- 输出样式 ----------
log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

# 以 admin 身份执行（保持文件属主一致，避免 root 和 admin 混着写）
as_app() { su - "$APP_USER" -c "$1"; }

STEP="环境检查"
trap 'code=$?; if [ $code -ne 0 ] && [ $code -ne 2 ]; then
  printf "\n\033[31m✗ 卡在第 %s 步（退出码 %s）\033[0m\n" "$STEP" "$code" >&2
  printf "  排错顺序：su - %s -c \"pm2 logs %s --lines 50\" / free -h / cat %s/my-app/.env.local\n" "$APP_USER" "$APP_NAME" "$APP_DIR" >&2
fi' EXIT

# =====================================================================
# 0. 环境检查
# =====================================================================
log "0/7 环境检查"

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash $0"

if ! command -v apt-get >/dev/null 2>&1; then
  cat <<'EOF' >&2
✗ 这台机器不是 Debian/Ubuntu 系，本脚本的 apt 命令用不了。

  阿里云默认镜像经常是「Alibaba Cloud Linux 3」或「CentOS」，
  这种情况最省事的做法是去控制台「更换操作系统」，换成 Ubuntu 22.04，
  再回来跑这个脚本。继续在 CentOS 上折腾 yum 只会浪费你半小时。
EOF
  exit 1
fi

id "$APP_USER" >/dev/null 2>&1 || die "服务器上没有 $APP_USER 用户，脚本布局对不上，先手动确认部署目录"

info "系统：$(. /etc/os-release && echo "$PRETTY_NAME")"
info "内存：$(free -h | awk '/^Mem:/{print $2}')　Swap：$(free -h | awk '/^Swap:/{print $2}')"
info "磁盘：$(df -h / | awk 'NR==2{print $4" 可用"}')"

if [ "$MODE" = "check" ]; then
  log "检查模式：只看不改"
  info "node：$(node -v 2>/dev/null || echo 未安装)"
  info "pm2：$(as_app 'pm2 -v' 2>/dev/null | tail -1)"
  as_app "pm2 list" 2>/dev/null | grep -E "tanchishe" | head -2 || true
  [ -f "$APP_DIR/my-app/.env.local" ] && ok ".env.local 存在" || warn ".env.local 缺失"
  info "代码版本：$(git -C "$APP_DIR" log --oneline -1 2>/dev/null || echo 非 git 目录)"
  info "端口 $PORT：$(ss -ltnp 2>/dev/null | grep -c ":$PORT" || true) 个进程监听"
  printf '\n  检查完毕，去掉 --check 即可正式部署。\n\n'
  exit 0
fi

# =====================================================================
# 1. 交换空间（防 npm run build 被 OOM 杀掉）
# =====================================================================
STEP="交换空间"
log "1/7 交换空间"

if swapon --show | grep -q .; then
  ok "已有 swap：$(free -h | awk '/^Swap:/{print $2}')，跳过"
else
  info "内存不足时 next build 会被系统直接杀掉（日志里只有一行 Killed），先加 $SWAP_SIZE 兜底"
  if fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null; then
    ok "fallocate 创建成功"
  else
    warn "fallocate 不被支持，改用 dd（慢一点，约 30 秒）"
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap 已启用并写入 /etc/fstab"
fi

# =====================================================================
# 2. 系统依赖
# =====================================================================
STEP="系统依赖"
log "2/7 系统依赖"

if [ "$MODE" = "update" ]; then
  ok "发版模式，跳过 apt 安装"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates nginx >/dev/null
  ok "curl / git / nginx 就绪"

  NEED_NODE=1
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
    if [ "$NODE_MAJOR" -ge 22 ]; then
      ok "Node 已满足要求：$(node -v)"
      NEED_NODE=0
    else
      warn "Node 版本过低（$(node -v)），Next.js 16 需要 20.9+，升级中"
    fi
  fi

  if [ "$NEED_NODE" -eq 1 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    ok "Node 安装完成：$(node -v)"
  fi

  if ! as_app "command -v pm2" >/dev/null 2>&1; then
    as_app "npm i -g pm2" >/dev/null 2>&1
    ok "pm2 已安装"
  else
    ok "pm2 就绪"
  fi
fi

# =====================================================================
# 3. 拉取代码
# =====================================================================
STEP="拉取代码"
log "3/7 拉取代码"

if [ -d "$APP_DIR/.git" ]; then
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  info "目录已存在，同步到 origin/main"
  # 部署目录不是开发目录：服务器上的本地改动会被丢弃
  as_app "cd $APP_DIR && git fetch origin --prune -q && git reset --hard origin/main -q" \
    || die "git 同步失败，先确认服务器能不能访问 GitHub：git ls-remote $REPO_URL"
  ok "已同步：$(git -C "$APP_DIR" log --oneline -1)"
elif [ -d "$APP_DIR/my-app" ]; then
  ok "检测到已上传的代码目录（非 git 仓库），跳过拉取"
elif [ -d "$APP_DIR" ]; then
  die "$APP_DIR 存在但不是有效代码目录，先清理再重试"
else
  mkdir -p "$(dirname "$APP_DIR")"
  info "克隆 $REPO_URL"
  git clone -q "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  ok "克隆完成：$(git -C "$APP_DIR" log --oneline -1)"
fi

APP_ROOT="$APP_DIR/my-app"
[ -d "$APP_ROOT" ] || die "找不到 $APP_ROOT，仓库结构可能变了"

# =====================================================================
# 4. 环境变量（唯一需要手动准备的东西）
# =====================================================================
STEP="环境变量"
log "4/7 环境变量"

ENV_FILE="$APP_ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  ok ".env.local 已存在（$(grep -c '=' "$ENV_FILE" || true) 行配置）"
  grep -q '^DATABASE_URL=' "$ENV_FILE" || warn ".env.local 里没找到 DATABASE_URL，排行榜可能会 500"
else
  cat <<EOF

  ⚠️  服务器上还没有 .env.local —— 数据库连接串不能进 Git，必须单独传。

  在你的 Windows 电脑上（Git Bash）执行这一条：

      scp "C:/Users/wwwwww/Desktop/tanchishe/my-app/.env.local" root@<公网IP>:$ENV_FILE

  传完再跑一次本脚本，已完成的前几步会自动跳过。

EOF
  exit 2
fi

# =====================================================================
# 5. 清端口 → 安装依赖 → 构建
# =====================================================================
STEP="清理端口"
log "5/7 安装依赖并构建"

# 孤儿进程占着 3000 会让新进程反复 EADDRINUSE 崩溃，
# 表现是 pm2 里重启次数疯涨、网站 502。先清干净。
if ss -ltnp 2>/dev/null | grep -q ":$PORT"; then
  warn "端口 $PORT 已被占用，清理中"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 2
  if ss -ltnp 2>/dev/null | grep -q ":$PORT"; then
    die "端口 $PORT 仍被占用，手动查：ss -ltnp | grep $PORT"
  fi
fi
ok "端口 $PORT 可用"

STEP="安装依赖"
info "npm install（首次约 1~2 分钟）"
as_app "cd $APP_ROOT && npm install --no-audit --no-fund 2>&1 | tail -3"

STEP="构建"
info "npm run build（约 1~3 分钟）"
as_app "cd $APP_ROOT && npm run build 2>&1 | tail -25" \
  || die "构建失败。如果是被 Killed，回第 1 步确认 swap：free -h"
ok "构建完成"

# =====================================================================
# 6. 启动进程
# =====================================================================
STEP="启动进程"
log "6/7 启动服务（pm2 单实例 fork 模式）"

if as_app "pm2 describe $APP_NAME" >/dev/null 2>&1; then
  as_app "pm2 restart $APP_NAME --update-env" >/dev/null
  ok "已重启 $APP_NAME"
else
  # 注意：绝不能加 -i 参数。联机房间状态存在进程内存里，
  # 多实例会让「朋友 A 建的房间」对朋友 B 不存在。
  as_app "cd $APP_ROOT && pm2 start npm --name $APP_NAME -- start" >/dev/null
  ok "已启动 $APP_NAME"
fi

as_app "pm2 save" >/dev/null
if ! systemctl is-enabled "pm2-$APP_USER" >/dev/null 2>&1; then
  pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null 2>&1 || true
  ok "已设置开机自启"
else
  ok "开机自启已配置（pm2-$APP_USER.service）"
fi

info "等待进程监听 $PORT 端口…"
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT" && break
  sleep 1
done

if curl -fsS -o /dev/null "http://127.0.0.1:$PORT"; then
  ok "应用已在 127.0.0.1:$PORT 正常响应"
else
  warn "应用没响应，看日志：su - $APP_USER -c \"pm2 logs $APP_NAME --lines 50\""
fi

# =====================================================================
# 7. Nginx 反向代理
# =====================================================================
STEP="Nginx"
log "7/7 Nginx 反向代理（80 → 3000）"

if grep -q "proxy_read_timeout" /etc/nginx/sites-available/tanchishe 2>/dev/null; then
  ok "配置已包含 WebSocket 超时设置，跳过"
else
  cp /etc/nginx/sites-available/tanchishe "/etc/nginx/sites-available/tanchishe.bak.$(date +%s)" 2>/dev/null || true
  cat > /etc/nginx/sites-available/tanchishe <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # 联机走 WebSocket，必须转发 Upgrade 头，否则房间能建、朋友进不来
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # nginx 默认 60 秒无数据就断，大厅里等朋友进来会莫名掉线
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/tanchishe /etc/nginx/sites-enabled/tanchishe
  ok "已写入新配置"
fi

if nginx -t >/dev/null 2>&1; then
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx
  ok "nginx 配置生效"
else
  nginx -t
  die "nginx 配置有问题，上面是详细报错"
fi

# =====================================================================
# 完成
# =====================================================================
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<你的公网IP>')"

printf '\n\033[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
printf '\033[1;32m  部署完成 🐍\033[0m\n'
printf '\033[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n\n'
printf '  游戏地址   \033[4mhttp://%s\033[0m\n' "$PUBLIC_IP"
printf '  联机大厅   \033[4mhttp://%s/room\033[0m\n\n' "$PUBLIC_IP"
printf '  日常运维：\n'
printf '    su - %s -c "pm2 logs %s"        看日志\n' "$APP_USER" "$APP_NAME"
printf '    su - %s -c "pm2 restart %s"     重启（会清空进行中的房间）\n' "$APP_USER" "$APP_NAME"
printf '    bash deploy.sh --update         拉最新代码重新部署\n\n'
