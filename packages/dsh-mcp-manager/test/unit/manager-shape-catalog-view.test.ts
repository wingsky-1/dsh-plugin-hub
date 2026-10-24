/** Manager 方法面的自然职责测试与专属fixture。 */

import { describe, expect, it } from "vitest";

import { setupManagerTestLifecycle } from "./manager-shape-support.ts";

import {
  diskView,
  noUnitView,
  projectView,
  registerCatalogViewHooks,
  unitView,
} from "./manager-shape-catalog-view-fixture.ts";
setupManagerTestLifecycle();
describe("#569 catalogViewFor 合成注入端目录视图", () => {
  registerCatalogViewHooks();

  it("无单元时全局走 B", async () => {
    const { view } = await noUnitView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("无单元时项目走 B", async () => {
    const { view } = await noUnitView();
    expect(view.get("p1")?.summary).toBe("B-project-p1");
  });

  it("有单元时全局覆盖为中间层目录摘要", async () => {
    const { view } = await unitView();
    expect(view.get("g1")?.summary).toBe("Global search the web for facts.");
  });

  it("中间层无 g2 → 保留 B", async () => {
    const { view } = await unitView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });

  it("project scope 覆盖为项目单元摘要", async () => {
    const { view } = await unitView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  it("项目级有单元 → 走中间层目录", async () => {
    const { view } = await projectView();
    expect(view.get("p1")?.summary).toBe("Project read files.");
  });

  it("全局无 @global 单元 → B", async () => {
    const { view } = await projectView();
    expect(view.get("g1")?.summary).toBe("B-global-g1");
  });

  it("unavailable 目录视为无 → 保留 B", async () => {
    const { view } = await projectView();
    expect(view.get("p2")?.summary).toBe("B-project-p2");
  });

  it("单元缺失 → 磁盘 last-good 兜底", async () => {
    const { view } = await diskView();
    expect(view.get("g1")?.summary).toBe("Disk cached global search.");
  });

  it("磁盘无该服务器 → 保留 B", async () => {
    const { view } = await diskView();
    expect(view.get("g2")?.summary).toBe("B-global-g2");
  });
});
