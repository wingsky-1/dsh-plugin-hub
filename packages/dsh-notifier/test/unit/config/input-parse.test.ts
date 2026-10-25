/**
 * dsh-notifier config input parseJsonObject 自然块。
 */
import { describe, expect, it } from "vitest";

import { parseJsonObject } from "../../../src/server/config/impl/input/index.ts";
describe("parseJsonObject：坏内容一律当空设置", () => {
  it("坏 JSON 与非对象文本一律得到空设置（配置文件被手改坏时读面回落默认，而不是让整个插件装配失败）", () => {
    for (const text of ["", "{", "[]", "12", '"x"', "null", "true", "[{}]"]) {
      expect(parseJsonObject(text), `text=${JSON.stringify(text)}`).toEqual({});
    }
  });

  it("合法对象原样读出，嵌套与陌生键都不在这里处理（净化与归一化是后面的工序）", () => {
    expect(parseJsonObject('{"notifyAsk":false,"future":{"a":[1,2]}}')).toEqual({
      notifyAsk: false,
      future: { a: [1, 2] },
    });
  });
});
