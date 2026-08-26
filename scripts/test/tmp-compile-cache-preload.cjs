"use strict";
// #276 方案 A spike 实验预加载（临时，未跟踪）：
// 启用 Node compile cache，缓存 strip-types/插桩产物的 V8 编译数据，
// 供 sandbox worker 进程复用（业界对策：nodejs/node#56629 TS 纳入 compile cache）。
require("node:module").enableCompileCache();
