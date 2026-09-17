#include <stdio.h>
#include "local.h"

// 行注释里出现字符串 "not a string"
#define MAX_COUNT 42 /* 宏内的注释 */
const char *marker = "// 字符串里的斜杠不是注释";
const char *blockMarker = "/* 字符串里的块注释标记 */";
/* 块注释
   跨多行 "字符串标记" */
int main(void) {
  char character = '/';
  return MAX_COUNT;
}
