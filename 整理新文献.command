#!/bin/zsh
cd "$(dirname "$0")"

# 检测并安装依赖（缺什么 pip 装什么）
python3 scripts/check_deps.py
if [ $? -ne 0 ]; then
    echo
    echo "[启动失败] 依赖未就绪。请查看上方信息修复后重试。"
    read -k 1
    exit 1
fi

python3 scripts/organize.py "$@"
echo
echo "整理完成。按任意键关闭窗口。"
read -k 1
