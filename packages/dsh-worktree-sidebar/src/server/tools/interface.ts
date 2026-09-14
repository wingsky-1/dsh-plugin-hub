/**
 * tools 域对外契约：三个 agent 工具的注册与释放。
 *
 * 工具按 **agent 作用域**注册（每个 agent 自己的 `ctx.tools`），只在会话位于 git 仓库里时才装；
 * 会话不在仓库里就一个工具都不给——给了也只会每次都失败。
 *
 * 本文件只做收口：`ToolsInstance` 与装配的物理定义在 `impl/service`。
 * 那个类型刻意不从这里转出——组合根只调用它返回的 `dispose`，类型由推断给出，
 * 转出一个无人命名的类型只会让「它是契约」变成一句没人校验的话。
 */
export { createTools } from "./impl/service/index.ts";
