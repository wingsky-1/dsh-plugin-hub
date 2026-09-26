import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareVersions,
  createUpgradeRunner,
  diagnoseGap,
  newestTargetVersion,
  packageRootFrom,
  pluginVersion,
  runUpgradeChain,
  selectPendingSteps,
} from "../upgrade-chain.js";
import type { UpgradePorts, UpgradeStep } from "../upgrade-chain.js";

/** 判词前缀换成别的包名：三包文案逐字可比，故注入 label 就能断言前缀确实来自调用方。 */
const LABEL = "dsh-notifier";

/** 测试用的依赖面：只要一个可辨识字段，用于断言 deps 原样透传。 */
interface Deps {
  readonly marker: string;
}

const DEPS: Deps = { marker: "deps" };

function step(
  fromVersion: string,
  targetVersion: string,
  run: (deps: Deps) => void | Promise<void>,
): UpgradeStep<Deps> {
  return { fromVersion, targetVersion, run };
}

/** ports 的默认取值对「无待办步、刻度一致」成立：调用方只需覆写自己关心的那一面。 */
function ports(over: Partial<UpgradePorts<Deps>>): UpgradePorts<Deps> {
  return {
    label: LABEL,
    steps: [],
    deps: DEPS,
    readScale: () => "0.0.0",
    writeScale: () => {},
    targetVersion: "0.0.0",
    logger: { warn: () => {} },
    ...over,
  };
}

/** 测试落盘一律进隔离临时目录并清理，严禁在仓库内留下运行时产物。 */
function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-chain-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在 root 下造 depth 层子目录，返回最深那层。 */
function nest(root: string, depth: number): string {
  let current = root;
  for (let index = 0; index < depth; index += 1) {
    current = join(current, "d" + index);
  }
  mkdirSync(current, { recursive: true });
  return current;
}

// ------------------------------------------------------------------ 版本比较

test("compareVersions：逐段数值比较——0.10.0 > 0.9.0（判据：字符串比较会在这里判反）", () => {
  assert.equal("0.10.0" > "0.9.0", false, "前提：字符串比较确实把这个反例判反（认为 0.10.0 更小）");
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.10.0"), 0);
});

test("compareVersions：段数不同按缺位补零（0.3 等价 0.3.0）", () => {
  assert.equal(compareVersions("0.3", "0.3.0"), 0);
  assert.equal(compareVersions("1", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1"), 1);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
});

test("compareVersions：预发布后缀显式剥离，不参与比较", () => {
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.1"), -1);
});

test("compareVersions：段非纯数字归零且不抛（读盘数据不可信，抛即崩）", () => {
  assert.doesNotThrow(() => compareVersions("x.y.z", "0.0.0"));
  assert.equal(compareVersions("x.y.z", "0.0.0"), 0);
  assert.equal(compareVersions("1.x.3", "1.0.0"), 1);
  assert.equal(compareVersions("", "0.0.0"), 0);
});

// ------------------------------------------------------------------ 步骤筛选

test("selectPendingSteps：按目标版本升序执行（声明顺序只是阅读顺序），且不改入参", () => {
  const steps = [
    step("0.2.0", "0.3.0", () => {}),
    step("0.0.0", "0.1.0", () => {}),
    step("0.1.0", "0.2.0", () => {}),
  ];
  const declared = steps.map((entry) => entry.targetVersion);

  const pending = selectPendingSteps(steps, "0.0.0");

  assert.deepEqual(
    pending.map((entry) => entry.targetVersion),
    ["0.1.0", "0.2.0", "0.3.0"],
  );
  assert.deepEqual(
    steps.map((entry) => entry.targetVersion),
    declared,
    "入参被就地排序了",
  );
  assert.notEqual(pending, steps, "返回的必须是新数组");
});

test("selectPendingSteps：起点边界——fromVersion 等于刻度也算待办（等于即待办）", () => {
  const steps = [
    step("0.0.0", "0.1.0", () => {}),
    step("0.1.0", "0.2.0", () => {}),
    step("0.2.0", "0.3.0", () => {}),
  ];
  assert.deepEqual(
    selectPendingSteps(steps, "0.0.0").map((entry) => entry.targetVersion),
    ["0.1.0", "0.2.0", "0.3.0"],
  );
  assert.deepEqual(
    selectPendingSteps(steps, "0.1.0").map((entry) => entry.targetVersion),
    ["0.2.0", "0.3.0"],
  );
  assert.deepEqual(selectPendingSteps(steps, "0.3.0"), []);
});

test("newestTargetVersion：取最高目标版本；空表给空串（空串是没有步骤可谈的哨兵）", () => {
  assert.equal(
    newestTargetVersion([step("0.1.0", "0.2.0", () => {}), step("0.0.0", "0.3.0", () => {})]),
    "0.3.0",
  );
  assert.equal(newestTargetVersion([]), "");
});

// ------------------------------------------------------------------ 对账诊断

test("diagnoseGap：落后（behind）——kind 与判词逐字（漏写升级步骤）", () => {
  const table = [step("0.1.0", "0.2.0", () => {}), step("0.0.0", "0.1.0", () => {})];
  assert.deepEqual(diagnoseGap(table, "0.1.0", "0.3.0", LABEL), {
    kind: "behind",
    message: LABEL + ": 存储版本 0.1.0 落后于插件版本 0.3.0，缺少对应的升级步骤",
  });
});

test("diagnoseGap：步骤表本身也超前（ahead-of-steps）——kind 与判词逐字", () => {
  const table = [step("0.1.0", "0.4.0", () => {}), step("0.0.0", "0.2.0", () => {})];
  assert.deepEqual(diagnoseGap(table, "0.4.0", "0.3.0", LABEL), {
    kind: "ahead-of-steps",
    message:
      LABEL +
      ": 升级链的目标版本 0.4.0 高于插件版本 0.3.0（存储已升到 0.4.0）——步骤表与 package.json 不同步",
  });
});

test("diagnoseGap：存储超前而步骤表没超前（downgrade）——kind 与判词逐字", () => {
  const table = [step("0.0.0", "0.2.0", () => {})];
  assert.deepEqual(diagnoseGap(table, "0.5.0", "0.3.0", LABEL), {
    kind: "downgrade",
    message: LABEL + ": 存储版本 0.5.0 高于插件版本 0.3.0，本插件的升级链不回退",
  });
});

test("diagnoseGap：刻度与插件版本一致时返回 null（无需告警）", () => {
  assert.equal(diagnoseGap([step("0.0.0", "0.1.0", () => {})], "0.3.0", "0.3.0", LABEL), null);
});

test("diagnoseGap：空步骤表时按 downgrade 报，不虚报「步骤表与 package.json 不同步」", () => {
  assert.deepEqual(diagnoseGap([], "0.4.0", "0.3.0", LABEL), {
    kind: "downgrade",
    message: LABEL + ": 存储版本 0.4.0 高于插件版本 0.3.0，本插件的升级链不回退",
  });
});

// ------------------------------------------------------------------ 链驱动

test("runUpgradeChain：每步 run 成功后立刻回写刻度（第 1 步的回写早于第 2 步的 run）", async () => {
  const order: string[] = [];
  let scale = "0.0.0";

  const result = await runUpgradeChain(
    ports({
      steps: [
        step("0.0.0", "0.1.0", async () => {
          order.push("run:0.1.0");
        }),
        step("0.1.0", "0.2.0", async () => {
          order.push("run:0.2.0");
        }),
      ],
      readScale: () => scale,
      writeScale: (version) => {
        scale = version;
        order.push("write:" + version);
      },
      targetVersion: "0.2.0",
    }),
  );

  assert.deepEqual(order, ["run:0.1.0", "write:0.1.0", "run:0.2.0", "write:0.2.0"]);
  assert.equal(scale, "0.2.0");
  assert.equal(result, undefined, "链跑完没有产物可言，刻度才是产物");
});

test("runUpgradeChain：步骤之间严格串行——第 2 步不早于第 1 步回写完成（不并发、不浮起）", async () => {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  const order: string[] = [];
  let firstWriteFinishedAt = 0;
  let secondStartedAt = 0;
  let writes = 0;
  let scale = "0.0.0";

  await runUpgradeChain(
    ports({
      steps: [
        step("0.0.0", "0.1.0", async () => {
          order.push("run1:start");
          await delay();
          order.push("run1:end");
        }),
        step("0.1.0", "0.2.0", async () => {
          secondStartedAt = performance.now();
          order.push("run2:start");
          await delay();
          order.push("run2:end");
        }),
      ],
      readScale: () => scale,
      writeScale: (version) => {
        scale = version;
        order.push("write:" + version);
        writes += 1;
        if (writes === 1) firstWriteFinishedAt = performance.now();
      },
      targetVersion: "0.2.0",
    }),
  );

  // 并发执行（执行器漏 await 每一步）时 order 会是 run1:start → run2:start → …，逐字断言先红。
  assert.deepEqual(order, [
    "run1:start",
    "run1:end",
    "write:0.1.0",
    "run2:start",
    "run2:end",
    "write:0.2.0",
  ]);
  assert.ok(
    secondStartedAt >= firstWriteFinishedAt,
    "第 2 步起始 " + secondStartedAt + " 早于第 1 步回写完成 " + firstWriteFinishedAt,
  );
});

test("runUpgradeChain：同步写的 step 同样被执行并逐步回刻度（统一异步链不强迫 step 异步）", async () => {
  const order: string[] = [];
  let scale = "0.0.0";

  await runUpgradeChain(
    ports({
      steps: [
        step("0.0.0", "0.1.0", () => {
          order.push("sync-run");
        }),
      ],
      readScale: () => scale,
      writeScale: (version) => {
        scale = version;
        order.push("write:" + version);
      },
      targetVersion: "0.1.0",
    }),
  );

  assert.deepEqual(order, ["sync-run", "write:0.1.0"]);
  assert.equal(scale, "0.1.0");
});

test("runUpgradeChain：deps 原样透传给每一步 run", async () => {
  const seen: Deps[] = [];
  await runUpgradeChain(
    ports({
      deps: { marker: "narrow-face" },
      steps: [
        step("0.0.0", "0.1.0", (deps) => {
          seen.push(deps);
        }),
      ],
      targetVersion: "0.1.0",
    }),
  );
  assert.deepEqual(seen, [{ marker: "narrow-face" }]);
});

test("runUpgradeChain：中途失败——抛错带包名与目标版本、cause 透传、失败步不回写刻度", async () => {
  const boom = new Error("磁盘只读");
  const order: string[] = [];
  let scale = "0.0.0";

  await assert.rejects(
    runUpgradeChain(
      ports({
        steps: [
          step("0.0.0", "0.1.0", async () => {
            order.push("run:0.1.0");
          }),
          step("0.1.0", "0.2.0", async () => {
            order.push("run:0.2.0");
            throw boom;
          }),
        ],
        readScale: () => scale,
        writeScale: (version) => {
          scale = version;
          order.push("write:" + version);
        },
        targetVersion: "0.2.0",
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, LABEL + ": 存储升级到 0.2.0 失败 — 磁盘只读");
      assert.equal(error.cause, boom, "cause 必须透传，否则启动现场丢了原始故障");
      return true;
    },
  );

  assert.deepEqual(order, ["run:0.1.0", "write:0.1.0", "run:0.2.0"], "失败步不得回写刻度");
  assert.equal(scale, "0.1.0", "失败步的凭证绝不发给没做完的事");
});

test("runUpgradeChain：非 Error 抛出物也落进文案（不丢失败原因）", async () => {
  await assert.rejects(
    runUpgradeChain(
      ports({
        steps: [
          step("0.0.0", "0.1.0", () => {
            throw "字符串原因";
          }),
        ],
        targetVersion: "0.1.0",
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, LABEL + ": 存储升级到 0.1.0 失败 — 字符串原因");
      return true;
    },
  );
});

test("runUpgradeChain：回写失败——抛回写失败信息并带上目标版本", async () => {
  const boom = new Error("version 文件不可写");
  await assert.rejects(
    runUpgradeChain(
      ports({
        steps: [step("0.0.0", "0.1.0", () => {})],
        writeScale: () => {
          throw boom;
        },
        targetVersion: "0.1.0",
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, LABEL + ": 存储版本号回写失败（0.1.0）— version 文件不可写");
      assert.equal(error.cause, boom);
      return true;
    },
  );
});

test("runUpgradeChain：链跑完复读刻度对账，落差告警交给 logger.warn 且文案含 label", async () => {
  const warnings: string[] = [];
  let reads = 0;
  let scale = "0.0.0";

  await runUpgradeChain(
    ports({
      steps: [step("0.0.0", "0.1.0", () => {})],
      readScale: () => {
        reads += 1;
        return scale;
      },
      writeScale: (version) => {
        scale = version;
      },
      targetVersion: "0.3.0",
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
      },
    }),
  );

  assert.equal(reads, 2, "链跑完必须复读一次刻度，否则对账用的是开跑前的旧值");
  assert.equal(scale, "0.1.0", "对账告警不改变动作：刻度照写");
  assert.deepEqual(warnings, [LABEL + ": 存储版本 0.1.0 落后于插件版本 0.3.0，缺少对应的升级步骤"]);
});

test("runUpgradeChain：刻度推到插件版本时不开告警口（一致即静默）", async () => {
  const warnings: string[] = [];
  let scale = "0.0.0";
  await runUpgradeChain(
    ports({
      steps: [step("0.0.0", "0.1.0", () => {})],
      readScale: () => scale,
      writeScale: (version) => {
        scale = version;
      },
      targetVersion: "0.1.0",
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
      },
    }),
  );
  assert.deepEqual(warnings, []);
});

// ------------------------------------------------------------------ 装配器

test("createUpgradeRunner：重复装配抛「只能装配一次」（单例重复装配是编程错误）", async () => {
  const runner = createUpgradeRunner<Deps>(LABEL, async () => {});
  await runner.install(DEPS);
  await assert.rejects(runner.install(DEPS), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, LABEL + ": upgrade 域只能装配一次");
    return true;
  });
});

test("createUpgradeRunner：链抛错时不置标记——不 release 也能再装一次（宿主重试才有机会重跑链）", async () => {
  let attempts = 0;
  const runner = createUpgradeRunner<Deps>(LABEL, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("链炸了");
  });

  await assert.rejects(runner.install(DEPS), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "链炸了", "首次失败必须原样透出，不得被改写成「只能装配一次」");
    return true;
  });

  await assert.doesNotReject(runner.install(DEPS));
  assert.equal(attempts, 2);
});

test("createUpgradeRunner：release 复位后可重新装配，且 deps 原样传给链", async () => {
  const seen: Deps[] = [];
  const runner = createUpgradeRunner<Deps>(LABEL, async (deps) => {
    seen.push(deps);
  });

  await runner.install({ marker: "first" });
  await assert.rejects(runner.install(DEPS), /只能装配一次/);
  runner.release();
  await assert.doesNotReject(runner.install({ marker: "second" }));

  assert.deepEqual(seen, [{ marker: "first" }, { marker: "second" }]);
});

test("createUpgradeRunner：并发装配当场抛，链只跑一遍（在途标记，不靠 installed）", async () => {
  // 判据是「链只跑一遍」：单靠「跑完才置 installed」的门拦不住并发——第一次 install 在 await
  // 处让出时 installed 仍是 false，第二个调用会一起进链，两条链并发读写同一批存储文件。
  let runs = 0;
  // 每次进链各挂一个闸，闸门**逐个收集**。两个 install 全部先转成「已结算」形态再统一开闸：
  // 直接 await 第二个 install 会在守卫失效时死锁（它在等闸门，而闸门要等它返回才开）——
  // 用例从「红」退化成「挂死」，而挂死比红更难定位。本写法在守卫有无两种形态下都能走完。
  const gates: Array<() => void> = [];
  const runner = createUpgradeRunner<Deps>(LABEL, async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
  });
  const settled = (pending: Promise<unknown>): Promise<unknown> =>
    pending.then(
      () => "fulfilled",
      (error: unknown) => error,
    );

  const first = settled(runner.install(DEPS));
  const second = settled(runner.install(DEPS));
  await new Promise((resolve) => setImmediate(resolve));
  for (const open of gates) open();

  assert.equal(await first, "fulfilled", "第一次装配应当正常跑完");
  const rejection = await second;
  assert.ok(rejection instanceof Error, "第二次装配应当抛错而不是并跑");
  assert.equal(rejection.message, LABEL + ": upgrade 域正在装配中，不能并发装配");
  assert.equal(runs, 1, "并发调用不得让链跑第二遍");
  // 在途标记随链结束清掉：不是「一失败就永久卡死」，跑完之后照常受 installed 门约束。
  await assert.rejects(runner.install(DEPS), /只能装配一次/);
});

test("createUpgradeRunner：链抛错后在途标记一并清掉，不把 runner 永久卡在「装配中」", async () => {
  const runner = createUpgradeRunner<Deps>(LABEL, async () => {
    throw new Error("链炸了");
  });

  await assert.rejects(runner.install(DEPS), /链炸了/);
  // 同一个报错再次抛出，而不是「正在装配中」——说明 installing 已随 finally 清零。
  await assert.rejects(runner.install(DEPS), /链炸了/);
});

// ------------------------------------------------------------------ 刻度原语

test("packageRootFrom：从深层目录向上找到最近的含 package.json 的目录", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fx", version: "1.2.3" }),
      "utf8",
    );
    const deep = nest(dir, 3);
    assert.equal(packageRootFrom(deep), dir);
  });
});

test("packageRootFrom：8 层窗口内没有包根则 undefined（不一路走到文件系统根）", () => {
  withTempDir((dir) => {
    const deep = nest(dir, 7);
    assert.equal(packageRootFrom(deep), undefined);
  });
});

test("pluginVersion：读到包根 package.json 的 version", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fx", version: "1.2.3" }),
      "utf8",
    );
    assert.equal(pluginVersion(nest(dir, 2)), "1.2.3");
  });
});

test("pluginVersion：找不到包根时回落 0.0.0 且不抛", () => {
  withTempDir((dir) => {
    const deep = nest(dir, 7);
    assert.doesNotThrow(() => pluginVersion(deep));
    assert.equal(pluginVersion(deep), "0.0.0");
  });
});

test("pluginVersion：包清单损坏或缺 version 字段时同样回落 0.0.0（读盘不可信不阻断启动）", () => {
  withTempDir((dir) => {
    const broken = mkdtempSync(join(tmpdir(), "upgrade-chain-broken-"));
    try {
      writeFileSync(join(broken, "package.json"), "{ 不是 JSON", "utf8");
      assert.equal(pluginVersion(broken), "0.0.0");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx" }), "utf8");
    assert.equal(pluginVersion(dir), "0.0.0");
  });
});
