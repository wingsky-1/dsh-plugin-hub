import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dshHome } from "../../../../shared/dsh-home.js";
import { pollUntil } from "../helpers.ts";
import {
  configFile,
  historyFile,
  historyLines,
  home,
  mount,
  send,
  seqFile,
  sharedApi,
  storageDir,
} from "./smoke-support.ts";

describe("落盘隔离", () => {
  it("本次 run 的全部产物都住进临时 DSH_HOME，包私有目录里只有契约约定的五个文件", async () => {
    const { port } = await mount();
    await send(port, "/api/dsh-notifier/test", { method: "POST", body: "{}" });
    await pollUntil(() => historyLines().some((line) => line.kind === "test"), "历史落盘", 10_000);

    // 路径同源：单例的落盘位置全部由同一个 DSH_HOME 拼出来，而它指向本文件独占的临时目录。
    expect(dshHome()).toBe(home.dir);
    expect(historyFile.startsWith(home.dir)).toBe(true);
    expect(configFile.startsWith(home.dir)).toBe(true);
    expect(seqFile.startsWith(home.dir)).toBe(true);

    // 原子写会先落一个同目录临时文件，status 的防抖落盘可能正在飞：那是实现的中间物，剔掉再比对。
    await pollUntil(
      () =>
        readdirSync(storageDir)
          .filter((name) => !name.includes(".tmp-"))
          .sort()
          .join(",") ===
        [
          sharedApi.CONFIG_FILE_NAME,
          sharedApi.HISTORY_FILE_NAME,
          sharedApi.SEQ_FILE_NAME,
          sharedApi.STATUS_FILE_NAME,
          sharedApi.VERSION_FILE_NAME,
        ]
          .sort()
          .join(","),
      "五个存储文件齐备且没有多出来的产物",
      10_000,
    );
  });
});
