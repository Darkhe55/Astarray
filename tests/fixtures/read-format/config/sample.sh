#!/bin/bash
# 顶层注释

source ./lib/common.sh
. ./lib/other.sh

url="https://example.com/a//b"   # 尾随注释
single='# 单引号里的井号'
dynamic="$(dirname "$0")"

cat <<EOF
# heredoc 里的井号不是注释
url=https://example.com/c//d
EOF

source "$(dirname "$0")/lib/dynamic.sh"   # 动态导入保留
echo "$url"
