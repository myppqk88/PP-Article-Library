#!/bin/zsh
cd "$(dirname "$0")"

# ============================================================
# 首次运行 / git pull 后自动检测并安装依赖。
# check_deps.py 探测要 import 的包，缺什么就跑 pip install -r requirements.txt
# 已装齐时几乎瞬间通过（~50ms），不影响日常启动速度。
# ============================================================
python3 scripts/check_deps.py
if [ $? -ne 0 ]; then
    echo
    echo "[启动失败] 依赖未就绪。请查看上方信息修复后重试。"
    read -k 1
    exit 1
fi

python3 scripts/server.py
