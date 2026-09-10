# 设备视口与几何验证

> 读它的时机：改动涉及响应式/窄屏布局，需要逐档核验几何表现时。非响应式改动不需要
> 本文件。

## 逐档设定视口（用设备模拟 flag）

响应式改动必须**逐档设定视口**后核验，而不是缩放窗口：`window.resizeTo` 只能改窗口
宽度、高度不生效（实测 `resizeTo(768,1024)` 后 `innerHeight` 仍是默认值，pad/phone
档的第二维根本无法验证），同一条 `eval` 表达式内也读不到改动结果。

改用**设备模拟 flag**——任一页面命令（snapshot / click / eval / fill / wait /
screenshot / console）均可携带，**视口档一次性生效**：命令内设定、结束即清除，命令
之间互不影响。

`--width N` `--height N` `--dpr N`（设备像素比，默认 1）`--mobile`（边界见下）。
只给一维时另一维取当前视口值。

## 基线档与残留自检

先记录默认视口（`--browser` 的 headless 内核通常为 800x600）作为对照基准；逐档改视口
之后，再用一条**不带 flag** 的命令回读——数值回到基线，即证明「命令结束即清除」成立、
没有残留污染后续命令。这条回读既是残留自检，也是判定窄屏档是否**真的**生效的基准
（否则无法区分「窄屏生效」与「参数没起作用」）：

```bash
STATE="$DSH_HOME/browser.state"
# 基线档：不带设备 flag
node "$SKILL_BASE/scripts/browser-driver.mjs" eval --state "$STATE" --expression "innerWidth+'x'+innerHeight"
# 改档后回读：应回到基线值（否则说明有残留）
node "$SKILL_BASE/scripts/browser-driver.mjs" eval --state "$STATE" --expression "innerWidth+'x'+innerHeight"
```

## 采证据

```bash
# 两档视口各采一次证据（phone / pad）；--url state 用带令牌 URL，见 SKILL.md 硬前提
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$STATE" --url state --width 375 --height 667 --path phone.png
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$STATE" --url state --width 768 --height 1024 --path pad.png
# 高 DPI：元素截图（--selector）按 --dpr 输出物理像素（375x667 档 + --dpr 2 → 750x1334）；
# 整页截图（不带 --selector）固定输出 CSS 像素尺寸，不随 --dpr 放大
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$STATE" --url state --width 375 --height 667 --dpr 2 --selector "<css>" --path phone@2x.png
# 自证视口生效（设了参数不等于布局已按该档渲染）
node "$SKILL_BASE/scripts/browser-driver.mjs" eval --state "$STATE" --width 375 --height 667 \
  --expression "innerWidth+'x'+innerHeight+' mq='+matchMedia('(max-width: 640px)').matches"
```

每档至少断言四项（用 `eval` 或 `snapshot --selector` 返回的 `rect`）：

| 断言 | 表达式模板 | 判据 |
|------|-----------|------|
| 视口生效 | `innerWidth+'x'+innerHeight` | 等于设定档位 |
| 无横向溢出 | `document.documentElement.scrollWidth <= innerWidth + 1` | true（+1 容差防亚像素） |
| 关键元素在视口内 | `snapshot --selector <css>` 的 `rect` | `x >= 0 && x + rect.width <= innerWidth`，纵向可滚动到 |
| 落点复核 | 改视口前后各取一次 `rect` | 位移方向与幅度符合预期（如锚定侧边的元素随视口收窄内移） |

`position: fixed` 元素最容易在窄屏失效：除落点外，还要滚动到页面底部确认它仍可达、
不被安全区或软键盘遮住。

## 能力边界（越界承诺会误导真机判断）

- `--mobile` 启用移动 layout viewport 语义：页面无 `<meta name="viewport">` 时
  `innerWidth` **不再等于**设定宽度（实测 375 档会读回约 981）。要精确命中 CSS 断点
  时保持 mobile 关闭；只有需要复现真机 layout viewport 行为时才加 `--mobile`。
- **触控、软键盘、真实 UA、旋转、`dvh`/安全区不在本 skill 能力面内**：headless 内核
  无法完整模拟（`maxTouchPoints` 可设，但 `ontouchstart` 不生效）。涉及触控手势、
  软键盘弹出/收起、`visualViewport` 跟随的改动**必须真机验证**，以真机结果为准。
- 视口模拟只覆盖布局维度；某一档的结论只对该档成立。
