<template>
  <!-- 模板注释 -->
  <div :data-url="url">{{ count }}</div>
</template>

<script>
// 脚本注释
export default {
  data() {
    return { url: "https://example.com/m//n", count: 1 };
  },
};
</script>

<style scoped>
/* 样式注释 */
.a { background: url(https://example.com/o//p.png); }
</style>
