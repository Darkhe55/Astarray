import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DomainError } from "../../../packages/core/src/core/errors.js";
import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";
import type { MissionLeaseClaimInput } from "../../../packages/core/src/infra/mission-lease-store.js";

let temporaryDirectory: string;
let nowMilliseconds: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lease-"));
  nowMilliseconds = 1_800_000_000_000;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeStore(): MissionLeaseStore {
  return new MissionLeaseStore({
    stateDirectory: temporaryDirectory,
    nowMilliseconds: () => nowMilliseconds,
  });
}

function makeClaim(overrides: Partial<MissionLeaseClaimInput> = {}): MissionLeaseClaimInput {
  return {
    missionId: "mission-001",
    processInstanceId: "process-a",
    purpose: "run",
    ...overrides,
  };
}

describe("MissionLeaseStore 跨进程 mission 租约（T12-01）", () => {
  it("首次申请成功；另一进程实例对同一 mission 再申请返回 locked-active 且不覆盖属主", async () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const first = await storeA.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    const second = await storeB.tryAcquire(makeClaim({ processInstanceId: "process-b" }));
    expect(second.status).toBe("locked-active");
    if (second.status !== "locked-active") return;
    expect(second.lease.processInstanceId).toBe("process-a");

    const lease = await storeA.readLease("mission-001");
    expect(lease?.processInstanceId).toBe("process-a");
    expect(lease?.leaseRevision).toBe(1);
  });

  it("不同 mission 的租约互不影响", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ missionId: "mission-001" }));
    const other = await store.tryAcquire(makeClaim({ missionId: "mission-002" }));
    expect(other.status).toBe("acquired");
  });

  it("租约到期后再次申请返回 locked-stale 且不自动接管（fail-closed）", async () => {
    const storeA = makeStore();
    const first = await storeA.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    expect(first.status).toBe("acquired");

    nowMilliseconds += 31_000;
    const storeB = makeStore();
    const second = await storeB.tryAcquire(makeClaim({ processInstanceId: "process-b" }));
    expect(second.status).toBe("locked-stale");
    if (second.status !== "locked-stale") return;
    expect(second.lease.processInstanceId).toBe("process-a");

    const lease = await storeA.readLease("mission-001");
    expect(lease?.processInstanceId).toBe("process-a");
  });

  it("过期租约可经显式接管：leaseRevision +1 且属主更换；活动租约接管被拒", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));

    await expect(
      store.takeOverExpiredLease(
        "mission-001",
        1,
        makeClaim({ processInstanceId: "process-b", purpose: "recover" }),
      ),
    ).rejects.toMatchObject({ errorCode: "mission-locked" });

    nowMilliseconds += 31_000;
    const taken = await store.takeOverExpiredLease(
      "mission-001",
      1,
      makeClaim({ processInstanceId: "process-b", purpose: "recover" }),
    );
    expect(taken.leaseRevision).toBe(2);
    expect(taken.processInstanceId).toBe("process-b");

    const lease = await store.readLease("mission-001");
    expect(lease?.leaseRevision).toBe(2);
    expect(lease?.processInstanceId).toBe("process-b");
  });

  it("错误 revision 接管与不存在的租约接管均拒绝（stale-revision / mission-not-found）", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    nowMilliseconds += 31_000;

    await expect(
      store.takeOverExpiredLease("mission-001", 99, makeClaim({ processInstanceId: "process-b" })),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });

    await expect(
      store.takeOverExpiredLease("mission-missing", 1, makeClaim({ missionId: "mission-missing" })),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("持有者可续约延长到期时间；到期后续约被拒（mission-locked）", async () => {
    const store = makeStore();
    const first = await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;

    nowMilliseconds += 10_000;
    const renewed = await store.renewLease("mission-001", 1, "process-a");
    expect(renewed).not.toBeNull();
    expect(renewed?.leaseRevision).toBe(2);
    const leaseAfterRenew = await store.readLease("mission-001");
    expect(leaseAfterRenew?.renewsUntilIso).toBe(new Date(nowMilliseconds + 30_000).toISOString());

    nowMilliseconds += 35_000;
    await expect(
      store.renewLease("mission-001", 2, "process-a"),
    ).rejects.toMatchObject({ errorCode: "mission-locked" });
  });

  it("续约 revision 不匹配抛 stale-revision；无租约续约返回 null", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    await expect(
      store.renewLease("mission-001", 99, "process-a"),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    expect(await store.renewLease("mission-missing", 1, "process-a")).toBeNull();
  });

  it("属主正确释放后他人可取得；错误 revision 释放抛 stale-revision；重复释放返回 false", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));

    await expect(
      store.releaseLease("mission-001", 99, "process-a"),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });

    expect(await store.releaseLease("mission-001", 1, "process-a")).toBe(true);
    expect(await store.releaseLease("mission-001", 1, "process-a")).toBe(false);

    const again = await store.tryAcquire(makeClaim({ processInstanceId: "process-c" }));
    expect(again.status).toBe("acquired");
  });

  it("租约文件损坏时 fail-closed（journal-corrupted），绝不静默覆盖", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    const leaseFilePath = path.join(
      temporaryDirectory,
      "missions",
      "mission-001",
      "mission-lease.json",
    );
    await fs.writeFile(leaseFilePath, "{ 损坏的租约内容", "utf8");

    await expect(store.readLease("mission-001")).rejects.toMatchObject({
      errorCode: "journal-corrupted",
    });
    await expect(
      store.tryAcquire(makeClaim({ processInstanceId: "process-b" })),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });

    await fs.rm(leaseFilePath);
    const acquired = await store.tryAcquire(makeClaim({ processInstanceId: "process-b" }));
    expect(acquired.status).toBe("acquired");
  });

  it("missionId 路径穿越与非法段被本地拒绝（path-escape-attempt）", async () => {
    const store = makeStore();
    await expect(
      store.tryAcquire(makeClaim({ missionId: "../escape" })),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    await expect(
      store.tryAcquire(makeClaim({ missionId: "a/b" })),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    await expect(
      store.tryAcquire(makeClaim({ missionId: "..\\escape" })),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
    await expect(
      store.tryAcquire(makeClaim({ missionId: "" })),
    ).rejects.toMatchObject({ errorCode: "path-escape-attempt" });
  });

  it("DomainError 语义：mission-locked 不可安全重试（isRecoverable=false）", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));
    nowMilliseconds += 31_000;
    let error: DomainError | null = null;
    try {
      await store.takeOverExpiredLease("mission-001", 99, makeClaim({ processInstanceId: "process-b" }));
    } catch (caught) {
      error = caught as DomainError;
    }
    expect(error?.errorCode).toBe("stale-revision");
    expect(error?.isRecoverable).toBe(false);
  });

  it("readLeaseSummary：只读摘要区分活动/过期/本进程属主（CLI 并发门禁）", async () => {
    const store = makeStore();
    await store.tryAcquire(makeClaim({ processInstanceId: "process-a" }));

    const activeOther = await store.readLeaseSummary("mission-001", "process-b");
    expect(activeOther.exists).toBe(true);
    expect(activeOther.isActive).toBe(true);
    expect(activeOther.isOwnedByCurrentProcess).toBe(false);
    expect(activeOther.ownerProcessInstanceId).toBe("process-a");
    expect(activeOther.purpose).toBe("run");

    const activeSelf = await store.readLeaseSummary("mission-001", "process-a");
    expect(activeSelf.isOwnedByCurrentProcess).toBe(true);

    nowMilliseconds += 31_000;
    const stale = await store.readLeaseSummary("mission-001", "process-b");
    expect(stale.isActive).toBe(false);
    expect(stale.isOwnedByCurrentProcess).toBe(false);

    const missing = await store.readLeaseSummary("mission-missing", "process-b");
    expect(missing.exists).toBe(false);
    expect(missing.isActive).toBe(false);
    expect(missing.ownerProcessInstanceId).toBeNull();
  });
});
