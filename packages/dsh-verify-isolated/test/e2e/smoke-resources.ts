import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PKG_ROOT,
  REF_DIR,
  REF_FILES,
  SKILL_FILE,
  SCRIPTS_DIR,
  parseFrontmatter,
  scriptFile,
} from "./smoke-support";

export function resourcesSkillContract() {
  describe("1. skills 目录结构 + frontmatter", () => {
    let skillExists;
    let skillRaw;
    let fm;

    beforeAll(() => {
      skillExists = existsSync(SKILL_FILE);
      skillRaw = readFileSync(SKILL_FILE, "utf8");
      fm = parseFrontmatter(skillRaw);
    });

    it("skills/dsh-verify-isolated/SKILL.md 存在", () => {
      expect(skillExists).toBeTruthy();
    });

    it("SKILL.md frontmatter name", () => {
      expect(fm.name).toBe("dsh-verify-isolated");
    });

    it("description 含隔离环境", () => {
      expect(fm.description ?? "").toMatch(/隔离环境/);
    });

    // 防回归：脚本定位必须走 skill 资源 base（注入的 Base directory），不得
    // 写死 npm 副本形态的 node_modules 路径——link:/checkout 形态下该路径不存在
    it("SKILL.md 不得写死 node_modules/@wingsky-1 路径（应经 skill 资源 base 定位）", () => {
      expect(!skillRaw.includes("node_modules/@wingsky-1")).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- 2. 一键脚本随 skill 分发
}

export function distributedScriptsContract() {
  describe("2. 一键脚本随 skill 分发（node 实现，删除 .sh 不留 shim）", () => {
    it("verify-isolated.mjs 随 skill 目录分发", () => {
      expect(existsSync(scriptFile)).toBeTruthy();
    });

    it("verify-isolated.sh 已删除，不留 shim（skill 随包整体发布无新旧错配）", () => {
      expect(!existsSync(join(SCRIPTS_DIR, "verify-isolated.sh"))).toBeTruthy();
    });

    it("共享基础工具 lib/verify-core.mjs 随 skill 目录分发", () => {
      expect(existsSync(join(SCRIPTS_DIR, "lib", "verify-core.mjs"))).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- 3. cordis.patch.yml
}

export function bundledSkillPatchContract() {
  describe("3. cordis.patch.yml 复用官方 provider + bundledSkillDir 配置", () => {
    let patch;

    beforeAll(() => {
      patch = readFileSync(join(PKG_ROOT, "cordis.patch.yml"), "utf8");
    });

    it("patch 复用官方 dsh-skill-filesystem（archify 模式）", () => {
      expect(patch.includes("@deepseek-ai/dsh-skill-filesystem")).toBeTruthy();
    });

    it("providerName 配置", () => {
      expect(patch.includes("providerName: dsh-verify-isolated")).toBeTruthy();
    });

    it("includeDefaultRoots: false（只加载本包 skill，不加载项目/用户默认根）", () => {
      expect(patch.includes("includeDefaultRoots: false")).toBeTruthy();
    });

    it("bundledSkillDir 配置在位", () => {
      expect(patch.includes("bundledSkillDir:")).toBeTruthy();
    });

    it("bundledSkillDir 从包 manifest 解析（不猜路径）", () => {
      expect(patch.includes("@wingsky-1/dsh-verify-isolated/package.json")).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- 4. bundledSkillDir JS 表达式模拟
}

export function bundledSkillResolutionContract() {
  describe("4. bundledSkillDir JS 表达式模拟：从 profile baseUrl 解析包 → skills", () => {
    let resolvedSkills;

    beforeAll(() => {
      const req = createRequire(join(PKG_ROOT, "noop.js"));
      const manifestPath = req.resolve("@wingsky-1/dsh-verify-isolated/package.json");
      resolvedSkills = join(dirname(manifestPath), "skills");
    });

    it("bundledSkillDir 解析到包内 skills", () => {
      expect(resolvedSkills).toBe(join(PKG_ROOT, "skills"));
    });
  });

  // ---------------------------------------------------------------- 5. browser-driver.mjs 存在 + --help
}

export function skillDisclosureContract() {
  describe("7. SKILL.md 主线 + references/ 支线（渐进式披露：内容随分支下沉）", () => {
    let skillRaw;
    let refExists;
    let kernelRef;
    let vpRef;
    let manualRef;
    let contractRef;
    let skillLines;

    beforeAll(() => {
      skillRaw = readFileSync(SKILL_FILE, "utf8");
      refExists = {};
      for (const name of REF_FILES) refExists[name] = existsSync(join(REF_DIR, name));
      const refTextOf = (name) => readFileSync(join(REF_DIR, name), "utf8");
      kernelRef = refTextOf("browser-kernel.md");
      vpRef = refTextOf("viewport-geometry.md");
      manualRef = refTextOf("manual-setup.md");
      contractRef = refTextOf("script-contracts.md");
      skillLines = skillRaw.split("\n").length;
    });

    it.each(REF_FILES)("支线参考 references/%s 随 skill 分发", (name) => {
      expect(refExists[name]).toBeTruthy();
    });

    // 7a. 主线：每次触发都要用的判据与约束
    it("SKILL.md 含四重隔离说明", () => {
      expect(skillRaw.includes("四重隔离")).toBeTruthy();
    });

    it("SKILL.md 含多会话并行约束", () => {
      expect(skillRaw.includes("多会话并行")).toBeTruthy();
    });

    it("SKILL.md 自检清单含插件 DSH_HOME 感知项", () => {
      expect(skillRaw.includes("DSH_HOME 感知")).toBeTruthy();
    });

    it("SKILL.md 含遥测禁用原则", () => {
      expect(skillRaw.includes("DSH_TELEMETRY_DISABLED=1")).toBeTruthy();
    });

    it("SKILL.md 含显式回环原则", () => {
      expect(skillRaw.includes("--host 127.0.0.1")).toBeTruthy();
    });

    it("SKILL.md 含 PATH dsh 版本锚定用法", () => {
      expect(skillRaw.includes("PATH")).toBeTruthy();
      expect(skillRaw.includes("0.2.1-rc.2")).toBeTruthy();
      expect(skillRaw.includes("--dsh")).toBeFalsy();
    });

    it("SKILL.md 声明非回环访问形态的边界与官方选项", () => {
      expect(skillRaw.includes("--trusted-host")).toBeTruthy();
    });

    // 7b. 指针：每个 reference 都要有指向它的入口，且声明读它的时机（否则等于不可达）
    it.each(REF_FILES)("SKILL.md 指向 references/%s", (name) => {
      expect(skillRaw.includes(name)).toBeTruthy();
    });

    it("SKILL.md 声明 --help 为选项契约唯一事实源（正文不复述）", () => {
      expect(skillRaw.includes("唯一事实源")).toBeTruthy();
    });

    it("SKILL.md 保持主线体量（未超 260 行，超限说明支线内容回灌正文）", () => {
      expect(skillLines < 260).toBeTruthy();
    });

    // 7c. 支线：各自的 reference 自包含
    const kernelAnchors = [
      "DSH_VERIFY_CHROME",
      "ms-playwright",
      "Google Chrome.app",
      "ProgramFiles",
    ];
    it.each(kernelAnchors)("references/browser-kernel.md 含内核锚点 %s", (anchor) => {
      expect(kernelRef.includes(anchor)).toBeTruthy();
    });

    const viewportAnchors = ["--width", "设备视口与几何验证", "基线档", "resizeTo", "ontouchstart"];
    it.each(viewportAnchors)("references/viewport-geometry.md 含视口锚点 %s", (anchor) => {
      expect(vpRef.includes(anchor)).toBeTruthy();
    });

    it("references/viewport-geometry.md 保留 resizeTo 不可用的理由", () => {
      expect(vpRef.includes("高度不生效")).toBeTruthy();
    });

    // 防照抄锁：resizeTo 只作为「为何不用」的事实出现，示例代码块里不得再出现
    it("references/viewport-geometry.md 示例代码块不出现 resizeTo", () => {
      expect(
        vpRef
          .split("```bash")
          .slice(1)
          .every((b) => !b.split("```")[0].includes("resizeTo")),
      ).toBeTruthy();
    });

    const manualAnchors = [
      "DSH_HOME=$(mktemp -d)",
      "WELCOME_NOTICE_VERSION",
      "DSH_WEB_URL",
      "browser-driver.mjs",
    ];
    it.each(manualAnchors)("references/manual-setup.md 含手动步骤锚点 %s", (anchor) => {
      expect(manualRef.includes(anchor)).toBeTruthy();
    });

    const contractAnchors = ["WHITELIST_V", "verdict.json", "退出码", "symlink", "t0"];
    it.each(contractAnchors)("references/script-contracts.md 含契约锚点 %s", (anchor) => {
      expect(contractRef.includes(anchor)).toBeTruthy();
    });
  });
}

export function readmeContract() {
  describe("8. README 同步新能力", () => {
    let readme;

    beforeAll(() => {
      readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    });

    it("README 同步 browser-driver", () => {
      expect(readme.includes("browser-driver.mjs")).toBeTruthy();
    });

    it("README 同步 --browser 用法", () => {
      expect(readme.includes("--browser")).toBeTruthy();
    });

    it("README 同步四重隔离说明", () => {
      expect(readme.includes("四重隔离")).toBeTruthy();
    });

    it("README 同步 node 版脚本名（升级路径）", () => {
      expect(readme.includes("verify-isolated.mjs")).toBeTruthy();
    });

    it("README 同步设备模拟纯函数模块", () => {
      expect(readme.includes("emulation.mjs")).toBeTruthy();
    });

    it("README 同步视口档位用法", () => {
      expect(readme.includes("--width")).toBeTruthy();
    });

    it("README 不再以旧 bash 脚本路径作为当前用法（升级路径说明除外）", () => {
      expect(!readme.includes("scripts/verify-isolated.sh")).toBeTruthy();
    });
  });
}
