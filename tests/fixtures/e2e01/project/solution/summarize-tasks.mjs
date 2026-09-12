/**
 * E2E-01 fixture 参考实现（仅用于证明 fixture 成功路径可复现）。
 * 规则：重复 id → duplicate-task-id；依赖不在链中 → dependency-not-found；
 * 待处理标识按字典序排序。
 */
export function summarizeTaskChain(tasks) {
  const identifiers = new Set();
  for (const task of tasks) {
    if (identifiers.has(task.id)) {
      throw new Error(`duplicate-task-id: ${task.id}`);
    }
    identifiers.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!identifiers.has(dependency)) {
        throw new Error(`dependency-not-found: ${task.id} -> ${dependency}`);
      }
    }
  }
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const pendingTaskIdentifiers = tasks
    .filter((task) => task.status !== "done")
    .map((task) => task.id)
    .sort();
  return {
    totalCount: tasks.length,
    doneCount,
    pendingTaskIdentifiers,
    summaryText: `已完成 ${doneCount}/${tasks.length}；待处理 ${pendingTaskIdentifiers.length} 项`,
  };
}
