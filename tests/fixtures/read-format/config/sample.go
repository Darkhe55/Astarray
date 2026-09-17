package main

import "fmt"
import (
  "strings"

  "example.com/mod/pkg"
)

// 行注释
var url = "https://example.com/a//b"
var raw = `// 原始字符串里的双斜杠不是注释`
var runeValue = '/'
var quoted = "he said \"//\""

/* 块注释
   跨行 */
func main() {
  fmt.Println(strings.ToUpper(url))
}
