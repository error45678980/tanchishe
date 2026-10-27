#!/usr/bin/env bash
#
# 贪吃蛇 · 阿里云一键部署脚本
# ---------------------------------------------------------------
# 适用：Ubuntu 20.04 / 22.04 / 24.04（Debian 系），root 执行
# 用法：
#   首次部署   bash deploy.sh
#   之后更新   bash deploy.sh --update     （跳过系统安装，只拉代码重建）
#   只看计划   bash deploy.sh --check      （不改动任何东西，检查环境）
#
# 这个脚本是幂等的：重复执行不会把服务器搞乱，跑几遍结果都一样。
# ---------------------------------------------------------------
set -euo pipefail

REPO_URL="https://github.com/error45678980/tanchishe.git"
APP_DIR="/var/www/tanchishe"
APP_NAME="tanchishe"
PORT=3000
SWAP_SIZE="2G"

MODE="deploy"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --check)  MODE="check" ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
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

# 构建失败时给一句人话解释，而不是甩一堆 webpack 日志
trap 'code=$?; if [ $code -ne 0 ] && [ $code -ne 2 ]; then
  printf "\n\033[31m✗ 第 %s 步失败了（退出码 %s）\033[0m\n" "$STEP" "$code" >&2
  printf "  看报错里最上面那几行，通常是：内存不足 / .env.local 写错 / 依赖装不上\n" >&2
fi' EXIT

STEP="环境检查"

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

ARCH="$(uname -m)"
info "系统：$(. /etc/os-release && echo "$PRETTY_NAME")"
info "架构：$ARCH"
info "内存：$(free -h | awk '/^Mem:/{print $2}')　Swap：$(free -h | awk '/^Swap:/{print $2}')"
info "磁盘：$(df -h / | awk 'NR==2{print $4" 可用"}')"

if [ "$MODE" = "check" ]; then
  log "检查模式：只看不改"
  command -v node >/dev/null && info "node：$(node -v)" || warn "node 未安装"
  command -v pm2  >/dev/null && info "pm2：$(pm2 -v 2>/dev/null)" || warn "pm2 未安装"
  command -v nginx>/dev/null && info "nginx：已安装" || warn "nginx 未安装"
  [ -f "$APP_DIR/my-app/.env.local" ] && info ".env.local：已存在" || warn ".env.local：缺失"
  [ -d "$APP_DIR/.git" ] && info "代码目录：已存在" || warn "代码目录：未拉取"
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
  ok "swap 已启用并写入 /etc/fstab（重启后依然生效）"
fi

# =====================================================================
# 2. 系统依赖
# =====================================================================
STEP="系统依赖"
log "2/7 系统依赖"

if [ "$MODE" = "update" ]; then
  ok "更新模式，跳过 apt 安装"
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
    ok "Node 安装完成：$(node -v)　npm：$(npm -v)"
  fi

  command -v pm2 >/dev/null 2>&1 || { npm i -g pm2 >/dev/null 2>&1; ok "pm2 安装完成：$(pm2 -v 2>/dev/null)"; }
  command -v pm2 >/dev/null 2>&1 && ok "pm2 就绪：$(pm2 -v 2>/dev/null)"
fi

# =====================================================================
# 3. 拉取代码
# =====================================================================
STEP="拉取代码"
log "3/7 拉取代码"

if [ -d "$APP_DIR/.git" ]; then
  info "目录已存在，执行 git pull"
  git -C "$APP_DIR" fetch --all --prune -q
  git -C "$APP_DIR" reset --hard origin/main -q
  ok "已同步到最新：$(git -C "$APP_DIR" log --oneline -1)"
elif [ -d "$APP_DIR/my-app" ]; then
  # 用 tar + scp 上传的代码没有 .git，直接就地部署
  ok "检测到已上传的代码目录（非 git 仓库），跳过拉取"
elif [ -d "$APP_DIR" ]; then
  die "$APP_DIR 存在但不是有效代码目录（既没 .git 也没 my-app/），先清理再重试"
else
  mkdir -p "$(dirname "$APP_DIR")"
  info "克隆 $REPO_URL"
  git clone -q "$REPO_URL" "$APP_DIR"
  ok "克隆完成：$(git -C "$APP_DIR" log --oneline -1)"
fi

APP_ROOT="$APP_DIR/my-app"
[ -d "$APP_ROOT" ] || die "找不到 $APP_ROOT，仓库结构可能变了"

# =====================================================================
# 4. 环境变量（唯一需要你手动准备的东西）
# =====================================================================
STEP="环境变量"
log "4/7 环境变量"

ENV_FILE="$APP_ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  ok ".env.local 已存在（$(grep -c '=' "$ENV_FILE") 行配置）"
  grep -q '^DATABASE_URL=' "$ENV_FILE" || warn ".env.local 里没找到 DATABASE_URL，排行榜可能会 500"
else
  cat <<EOF

  ⚠️  服务器上还没有 .env.local —— 数据库连接串不能进 Git，必须单独传上来。

  在你的 Windows 电脑上（Git Bash）执行这一条：

      scp "C:/Users/wwwwww/Desktop/tanchishe/my-app/.env.local" root@<公网IP>:$ENV_FILE

  传完再跑一次本脚本，它会自动跳过已完成的前三步。

EOF
  exit 2
fi

# =====================================================================
# 5. 安装依赖 + 构建
# =====================================================================
STEP="安装依赖"
log "5/7 安装依赖并构建"

cd "$APP_ROOT"
info "npm install（首次约 1~2 分钟）"
npm install --no-audit --no-fund 2>&1 | tail -3

STEP="构建"
info "npm run build（约 1~3 分钟，卡住不动是正常的）"
if ! npm run build 2>&1 | tail -25; then
  die "构建失败。如果是被 Killed，回第 1 步确认 swap：free -h"
fi
ok "构建完成"

# =====================================================================
# 6. 启动进程
# =====================================================================
STEP="启动进程"
log "6/7 启动服务（pm2 单实例 fork 模式）"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env >/dev/null
  ok "已重启 $APP_NAME"
else
  # 注意：绝不能加 -i 参数。联机房间状态存在进程内存里，
  # 多实例会让「朋友 A 建的房间」对朋友 B 不存在。
  pm2 start npm --name "$APP_NAME" -- start >/dev/null
  ok "已启动 $APP_NAME"
fi

pm2 save >/dev/null
if ! systemctl is-enabled pm2-root >/dev/null 2>&1; then
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  ok "已设置开机自启"
else
  ok "开机自启已配置"
fi

info "等待进程监听 $PORT 端口…"
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT" && break
  sleep 1
done

if curl -fsS -o /dev/null "http://127.0.0.1:$PORT"; then
  ok "应用已在 127.0.0.1:$PORT 正常响应"
else
  warn "应用没响应，看看日志：pm2 logs $APP_NAME --lines 50"
fi

# =====================================================================
# 7. Nginx 反向代理
# =====================================================================
STEP="Nginx"
log "7/7 Nginx 反向代理（去掉 :3000 端口号）"

cat > /etc/nginx/sites-available/tanchishe <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # 联机走 WebSocket，必须转发 Upgrade 头，否则房间能建、朋友进不来
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
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
rm -f /etc/nginx/sites-enabled/default

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
printf '  打不开？九成是安全组没放行 80 端口：\n'
printf '  阿里云控制台 → 实例 → 安全组 → 配置规则 → 入方向 → 放行 80/80\n\n'
printf '  日常运维：\n'
printf '    pm2 logs %s        看日志\n' "$APP_NAME"
printf '    pm2 restart %s     重启（会清空进行中的房间）\n' "$APP_NAME"
printf '    bash deploy.sh --update   拉最新代码重新部署\n\n'
