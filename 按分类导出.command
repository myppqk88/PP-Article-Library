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

echo "请输入要导出的分类关键词，例如：开放科学 / AI辅助同行评议 / 数字人"
read CATEGORY
python3 scripts/export_by_category.py "$CATEGORY"
echo
echo "导出完成。按任意键关闭窗口。"
read -k 1
