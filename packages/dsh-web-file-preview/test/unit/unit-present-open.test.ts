// @ts-nocheck
/**
 * dsh-web-file-preview — 「打开文件」重定向纯逻辑（issue #698）。
 *
 * 地址构造的 golden 表与官方 @deepseek-ai/dsh-util-workspace-path@0.1.5-rc.1 的
 * `fileAddressFor` 逐条对拍一致（18/18，实施期以真实官方包实测）。官方右侧栏 tab
 * 以完整地址作 contentId 去重，任一条漂移都会让同一文件出现两个 tab，故此处锁死。
 *
 * 本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）：原每条 assert 对应
 * 一个 it（循环体经 it.each 展开为逐条可见用例），判定口径与断言集合均未改动。
 */
import { describe, expect, it } from "vitest";
import {
  PRESENT_OPEN_PATH,
  PENDING_TTL_MS,
  isOpenRequest,
  sessionIdOf,
  fileAddressFor,
  looksLikeFilePath,
  usablePending,
} from "../../src/index.ts";

const S = "s1";
const PREFIX = "dsh-resource://file/session/s1/";
const NOW = 1_000_000;

describe("#698 地址构造", () => {
  it("#698：官方打开路由常量", () => {
    expect(PRESENT_OPEN_PATH).toBe("/api/present.open");
  });

  /** [cwd, path, 期望地址]；与官方实现对拍通过。 */
  const addressCases = [
    ["/w", "a/b.md", `${PREFIX}a/b.md`],
    ["/w", "/w/a/b.md", `${PREFIX}a/b.md`],
    ["/w", "/w", `${PREFIX}`],
    ["/w/", "/w/a.md", `${PREFIX}a.md`],
    [undefined, "a/b.md", `${PREFIX}a/b.md`],
    ["", "/abs/x.md", `${PREFIX}/abs/x.md`],
    [undefined, "C:\\Users\\me\\a.ts", `${PREFIX}C:/Users/me/a.ts`],
    ["C:\\proj", "C:\\proj\\a.ts", `${PREFIX}a.ts`],
    [undefined, "\\\\server\\share\\a.txt", `${PREFIX}//server/share/a.txt`],
    ["/w", "src\\a.ts", `${PREFIX}src/a.ts`],
    ["/w", "./a/b.md", `${PREFIX}a/b.md`],
    ["/w", "dir/", `${PREFIX}dir/`],
    ["/w", "a b/中文#1?2.md", `${PREFIX}a%20b/%E4%B8%AD%E6%96%87%231%3F2.md`],
    ["/w", "a/../b.md", `${PREFIX}a/../b.md`],
    ["/w", "/other/abs.md", `${PREFIX}/other/abs.md`],
    ["/w", "", `${PREFIX}`],
    ["/w", "a%b.md", `${PREFIX}a%25b.md`],
    ["/w", "@a.md", `${PREFIX}%40a.md`],
  ];
  it.each(addressCases.map(([cwd, path, expected]) => ({
    title: `#698 地址构造 cwd=${JSON.stringify(cwd)} path=${JSON.stringify(path)}`,
    cwd,
    path,
    expected,
  })))("$title", ({ cwd, path, expected }) => {
    expect(fileAddressFor(S, cwd, path)).toBe(expected);
  });

  it("#698 会话 id 逐段编码", () => {
    expect(fileAddressFor("s 1/x", "/w", "a.md")).toBe("dsh-resource://file/session/s%201%2Fx/a.md");
  });
});

describe("#698 请求识别", () => {
  it("#698 命中打开请求", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0", { method: "POST" })).toBe(true);
  });

  it("#698 method 大小写归一", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0", { method: "post" })).toBe(true);
  });

  it("#698 reveal 刻意放行（决策 1）", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0&action=reveal", { method: "POST" })).toBe(false);
  });

  it("#698 显式 action=open 仍命中", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0&action=open", { method: "POST" })).toBe(true);
  });

  it("#698 无 init 视为 GET", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1", undefined)).toBe(false);
  });

  it("#698 非 POST", () => {
    expect(isOpenRequest("/api/present.open?sessionId=s1", { method: "GET" })).toBe(false);
  });

  it("#698 路径全等", () => {
    expect(isOpenRequest("/api/present.host", { method: "POST" })).toBe(false);
  });

  it("#698 前缀相似不误拦", () => {
    expect(isOpenRequest("/api/present.open.bak?sessionId=s1", { method: "POST" })).toBe(false);
  });

  it("#698 绝对 URL", () => {
    expect(isOpenRequest("http://127.0.0.1:3080/api/present.open?sessionId=s1", { method: "POST" })).toBe(true);
  });

  // 官方调用点是字符串 URL，但包装器必须对 Request 实例同样稳健。
  it("#698 Request 实例", () => {
    expect(isOpenRequest({ url: "http://127.0.0.1:3080/api/present.open?sessionId=s1", method: "POST" }, undefined)).toBe(true);
  });

  it("#698 init.method 优先于 Request.method", () => {
    expect(isOpenRequest({ url: "http://127.0.0.1:3080/api/present.open?sessionId=s1", method: "GET" }, { method: "POST" })).toBe(true);
  });

  it("#698 非 URL 入参不炸", () => {
    expect(isOpenRequest(42, { method: "POST" })).toBe(false);
  });

  describe("sessionIdOf（会话 id 提取）", () => {
    it("#698 取会话 id", () => {
      expect(sessionIdOf("/api/present.open?sessionId=abc&seq=1")).toBe("abc");
    });

    it("#698 缺 sessionId", () => {
      expect(sessionIdOf("/api/present.open?seq=1")).toBe(null);
    });

    it("#698 空 sessionId", () => {
      expect(sessionIdOf("/api/present.open?sessionId=")).toBe(null);
    });

    it("#698 不可解析", () => {
      expect(sessionIdOf("totally not a url path")).toBe(null);
    });
  });
});

describe("#698 点击路径采集", () => {
  describe("looksLikeFilePath", () => {
    it("#698 相对路径", () => {
      expect(looksLikeFilePath("src/a.ts")).toBe(true);
    });

    it("#698 绝对路径", () => {
      expect(looksLikeFilePath("/abs/a.ts")).toBe(true);
    });

    it("#698 Windows 路径", () => {
      expect(looksLikeFilePath("C:\\proj\\a.ts")).toBe(true);
    });

    it("#698 裸文件名带扩展名", () => {
      expect(looksLikeFilePath("README.md")).toBe(true);
    });

    it("#698 前后空白容忍", () => {
      expect(looksLikeFilePath("  pkg/index.ts  ")).toBe(true);
    });

    it("#698 空串", () => {
      expect(looksLikeFilePath("")).toBe(false);
    });

    it("#698 纯空白", () => {
      expect(looksLikeFilePath("   ")).toBe(false);
    });

    it("#698 URL 不是本地路径", () => {
      expect(looksLikeFilePath("https://example.com/a.ts")).toBe(false);
    });

    it("#698 非路径文本", () => {
      expect(looksLikeFilePath("打开")).toBe(false);
    });

    it("#698 多行不采信", () => {
      expect(looksLikeFilePath("a\nb")).toBe(false);
    });

    it("#698 超长不采信", () => {
      expect(looksLikeFilePath("x".repeat(2000))).toBe(false);
    });

    // 裸文件名形态的边界：正则两端都要求锚定（结尾非扩展名字符 / 缺扩展名主体 / 超长扩展名）。
    it("#698 结尾非扩展名字符不采信", () => {
      expect(looksLikeFilePath("a.md!")).toBe(false);
    });

    it("#698 缺扩展名主体不采信", () => {
      expect(looksLikeFilePath("a.")).toBe(false);
    });

    it("#698 扩展名超长不采信", () => {
      expect(looksLikeFilePath(`a.${"x".repeat(17)}`)).toBe(false);
    });
  });

  describe("usablePending", () => {
    it("#698 pending 可用", () => {
      expect(usablePending({ path: "src/a.ts", at: NOW }, NOW)).toBe("src/a.ts");
    });

    it("#698 pending 归一", () => {
      expect(usablePending({ path: " src/a.ts ", at: NOW }, NOW)).toBe("src/a.ts");
    });

    it("#698 未点击", () => {
      expect(usablePending(undefined, NOW)).toBe(null);
    });

    it("#698 过期 pending 不采信", () => {
      expect(usablePending({ path: "src/a.ts", at: NOW - PENDING_TTL_MS - 1 }, NOW)).toBe(null);
    });

    it("#698 非路径 title 不采信", () => {
      expect(usablePending({ path: "打开", at: NOW }, NOW)).toBe(null);
    });

    it("#698 非法时间戳", () => {
      expect(usablePending({ path: "src/a.ts", at: Number.NaN }, NOW)).toBe(null);
    });

    // 边界：TTL 恰好到期仍可用（判据是「超过」而非「达到」）。
    it("#698 TTL 边界（恰好等于有效期）仍采信", () => {
      expect(usablePending({ path: "src/a.ts", at: NOW - PENDING_TTL_MS }, NOW)).toBe("src/a.ts");
    });
  });
});
