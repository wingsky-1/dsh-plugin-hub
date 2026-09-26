/**
 * dsh-mcp-manager — server/config/impl/env/policy.ts：环境变量凭据策略门（#770-2 环境净化，B 相）。
 *
 * 两阶段校验中的第二阶段（第一阶段是 normalizeServer 的纯形状校验，不读环境）：
 * add / update / import 三个写边界在落盘前调用 assertEnvPolicy，对 env / headers /
 * url / args 做「目标键 + 值 provenance」双审——用户裁决：边界拒绝 + 豁免表，拒绝静默过滤。
 *
 * 为什么不在 normalizeServer 里做：normalize 是纯函数，而本门要读父进程环境快照做展开后
 * 审计（${VAR} 的值 provenance 只有读到快照才知道）；纯函数里读环境会让归一结果随调用
 * 时机漂移。形状问题归 normalize，环境策略问题归本门，两门职责不混。
 *
 * 双审口径（fail-closed，命中即抛错，绝不静默丢弃/置空）：
 * 1. 目标键审：键名按词精确匹配凭据词表（isSecretEnvName）。子串正则 SECRET_ENV_NAME 只作
 *    候选快筛，确证必须走词表——MONKEY / TURKEY_SIZE / KEYBOARD 这类含 KEY 子串的正当名
 *    在词级无命中，必须放行（误伤回归测试锁死）。
 * 2. 值 provenance 审：值里的 ${VAR} 引用若指向凭据形名（非豁免），而目标键本身非凭据形
 *    （如 DEBUG: "${MY_SECRET}"），即秘密被塞进非秘密槽位——子进程会把它当普通数据，
 *    且按名识别的脱敏/投影都认不出它，拦截。引用名是否已 set 不影响判定（unset 时展开
 *    为空串正是「零值消费」陷阱：换个环境就变泄漏，fail-closed 按名拦截）。
 * 3. 活秘密查重：展开后的非空值若与某个凭据形父环境变量的活值逐字相等（如 MY_TOKEN 的
 *    明文字面量与快照里 MY_TOKEN 相同），即把活秘密以明文 baked 进配置文件——轮转即漂移，
 *    且与「模板落盘、连接时展开」的不变量相悖，拦截并指引改用同名模板。
 *    豁免：凭据槽位经凭据引用取值（CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}"、
 *    Authorization: "Bearer ${CONTEXT7_API_KEY}"）是文档示例的合法形态，展开值等于活
 *    秘密是预期结果，不在此列；空值（""，客户端语义=继承父环境）不注册不比对。
 *
 * 报错文案只含键名/变量名与模板，不含任何字面量值：写边界的错误经路由统一错误边界
 * （handleError → redactError）原样进 400 body，而被拒配置尚未落盘、其展开值不在脱敏
 * 快照内——回显字面量即泄漏。模板形态（"${MY_SECRET}"）无秘密可泄，可以出现。
 */

import { SECRET_ENV_NAME } from "./index.ts";

/** 凭据词精确表（大写词形）：键名/引用名切词后逐词全等命中才算凭据形。 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  // 基础七词：与 SECRET_ENV_NAME 子串正则的词根一一对应，此处是「词」不是「子串」。
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "AUTH",
  // 复数形态：API_KEYS / AWS_CREDENTIALS / NPM_TOKENS 这类常见实名是凭据，不收即 fail-open。
  // 单数词已覆盖切词命中的大小写，复数只增这四个（KEYS 加了也不误伤：MONKEYS 与 KEYS 全等不等）。
  "KEYS",
  "TOKENS",
  "SECRETS",
  "CREDENTIALS",
  // headers 常见槽位：客户端占位示例即 Authorization: Bearer ${...}——Authorization 若不算
  // 凭据槽，该示例会被当成「秘密进非秘密槽」误杀。AUTH 子串旧口径本就覆盖它，此处收为整词。
  "AUTHORIZATION",
  // 无分隔符复合形态：字面量即 "APIKEY" / "SECRETKEY" / "AUTHTOKEN" 的写法（有分隔符的
  // API_KEY / SECRET_KEY 本就经 KEY/SECRET 词命中，不需要这里）。与前后缀粘连的形态
  // （如 "MYAPIKEY"）切词切不开仍会漏——注释写明：取精确性，宁漏此类怪名，不误伤正当名。
  "APIKEY",
  "SECRETKEY",
  "AUTHTOKEN",
]);

/**
 * 豁免表：正当非凭据变量名——该名在键位与引用位都不算凭据形（DSH_HOME 作键不触发目标键审，
 * ${DSH_HOME} 作引用不触发值审；值 provenance 照审，秘密引用塞进豁免槽照样拦截）。
 *
 * - DSH_HOME：宿主家目录（dshHome 接缝唯一事实源）。PATH 拼装（"${DSH_HOME}/bin"）、子进程
 *   cwd 派生都要读它，非凭据；切词 [DSH, HOME] 本就不命中词表，此处具名是防未来词表膨胀
 *   （若有人把 HOME 收进词表，DSH_HOME 仍须放行）。
 * 扩展规则：新增正当变量按名加项并注明原因；禁止按 DSH_ 前缀整片豁免——前缀豁免会把未来的
 * DSH_API_TOKEN 一并放行（fail-open），与本门方向相反。
 */
const EXEMPT_ENV_NAMES: ReadonlySet<string> = new Set(["DSH_HOME"]);

/** ${VAR} 引用抽取：字面量必须与 expandEnv 的替换口径逐字一致（门与展开同口径）。 */
export function extractEnvRefs(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  // 内联字面量：与 expandEnv 同源，matchAll 按调用点新建匹配器，无 lastIndex 残留风险；
  // expandEnv 侧若改口径，此函数与单测须同步跟进。
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    out.push(match[1]);
  }
  return out;
}

/**
 * 名是否为凭据形（精确判定）：豁免表优先 → 子串正则只作候选快筛 → 切词精确确证。
 *
 * 切词规则：大写后按非字母数字切分（下划线/连横线/点/空格都是词界），每词去尾数后查表。
 * 去尾数（TOKEN2 → TOKEN）收的是「带编号的凭据」常见写法；TURKEY2 → TURKEY 照样不命中，
 * 不引入新误伤。MONKEY / TURKEY_SIZE / KEYBOARD / AUTHOR_NAME 在此全灭（子串命中但无整词）。
 */
export function isSecretEnvName(name: unknown): boolean {
  if (typeof name !== "string" || name === "") return false;
  const upper = name.toUpperCase();
  if (EXEMPT_ENV_NAMES.has(upper)) return false;
  // 候选快筛：连子串都不含凭据词根的，直接放行。
  if (!SECRET_ENV_NAME.test(name)) return false;
  return upper.split(/[^A-Z0-9]+/).some((segment) => {
    if (segment === "") return false;
    if (SECRET_WORDS.has(segment)) return true;
    return SECRET_WORDS.has(segment.replace(/[0-9]+$/, ""));
  });
}

/** 用给定快照展开单个值（与 expandEnv 同语义：未设置 → 空字符串）。 */
function expandWithSnapshot(value: string, snapshot: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, refName) => {
    const resolved = snapshot[refName];
    return resolved !== undefined ? resolved : "";
  });
}

/** 非秘密槽位携带凭据引用（值 provenance 污染）：DEBUG 类键引用 MY_SECRET 一类。 */
function smuggleError(section: string, key: string, secretRef: string): Error {
  return new Error(
    `${section} key ${JSON.stringify(key)} must not reference secret variable ` +
      `\${${secretRef}}: ${JSON.stringify(key)} is not a secret-shaped name, so the live secret ` +
      `would land in a non-secret slot (the child sees it as ordinary data, and name-based ` +
      `redaction/projection cannot identify it); rename the key to the secret name ` +
      `(e.g. ${JSON.stringify(secretRef)}) or remove the reference`,
  );
}

/** 字面量与活秘密逐字相同（模板落盘不变量被破）：MY_TOKEN 明文一类。 */
function duplicateError(
  section: string,
  key: string,
  matchedVar: string,
  keyIsSecret: boolean,
): Error {
  const fix = keyIsSecret
    ? `replace the value with the template "\${${key}}" so only the reference is stored`
    : `move it under a secret-shaped key (e.g. ${JSON.stringify(matchedVar)}) with the template ` +
      `"\${${matchedVar}}", or stop duplicating the live secret`;
  return new Error(
    `${section} key ${JSON.stringify(key)} duplicates the live value of secret variable ` +
      `\${${matchedVar}}: persisting a live secret as a literal bakes rotation-sensitive material ` +
      `into the config file (it drifts on rotation, against the template-on-disk invariant); ${fix}`,
  );
}

/** 审计单个 env/headers 表（调用方保证入参是归一化后的形态；报错只读键名与模板，永不回显字面量）。 */
function checkMap(
  section: string,
  map: Record<string, unknown> | undefined,
  liveSecrets: ReadonlyMap<string, string>,
  snapshot: Record<string, string | undefined>,
): void {
  for (const [key, rawValue] of Object.entries(map ?? {})) {
    const raw = String(rawValue);
    const refs = extractEnvRefs(raw);
    const secretRefs = refs.filter((ref) => isSecretEnvName(ref));
    const keyIsSecret = isSecretEnvName(key);
    // 值 provenance 审：秘密引用只能进凭据槽。引用名命中即拦截，引用目标是否已 set 不问
    // （unset 展开为空串是零值消费陷阱；换个 set 了的环境同一份配置就变泄漏）。
    if (!keyIsSecret && secretRefs.length > 0) {
      throw smuggleError(section, key, secretRefs[0] as string);
    }
    // 活秘密查重：凭据槽位经凭据引用取值是合法形态（文档示例），展开值等于活秘密是预期
    // 结果，跳过本审；其余形态下展开值与任一活秘密逐字相等即明文 baked，拦截。
    if (keyIsSecret && secretRefs.length > 0) continue;
    const expanded = expandWithSnapshot(raw, snapshot);
    // 空值跳过：空串是客户端约定的继承父环境语义，且与脱敏 addSecretPair 空跳过同口径。
    if (expanded === "") continue;
    const matchedVar = liveSecrets.get(expanded);
    if (matchedVar !== undefined) {
      throw duplicateError(section, key, matchedVar, keyIsSecret);
    }
  }
}

/** 无键名可判凭据形的槽位（url 全串 / args 单元素）携带凭据引用（值 provenance 污染）。 */
function smuggleErrorForSlot(section: string, slot: string, secretRef: string): Error {
  return new Error(
    `${section} ${slot} must not reference secret variable ` +
      `\${${secretRef}}: ${section} carries the value to the child/network as ordinary data, ` +
      `and name-based redaction/projection cannot identify it; remove the reference or stop ` +
      `passing the live secret here`,
  );
}

/** url userinfo/查询值、args 元素值与活秘密逐字相同（模板落盘不变量被破）。 */
function duplicateErrorForSlot(
  section: string,
  slot: string,
  matchedVar: string,
  hint: string,
): Error {
  return new Error(
    `${section} ${slot} duplicates the live value of secret variable ` +
      `\${${matchedVar}}: persisting a live secret as a literal bakes rotation-sensitive material ` +
      `into the config file (it drifts on rotation, against the template-on-disk invariant); ${hint}`,
  );
}

/**
 * 审计单个 url（调用方保证入参是归一化后的形态；报错只读变量名与模板，永不回显字面量）。
 *
 * url 整体视为非秘密槽（无键名可判凭据形），与 env 同口径：
 * - 引用污染拦：串内 ${SECRET} 引用（set/unset 皆拦，与 checkMap 同口径）；
 * - 活秘密查重：仅 userinfo（username/password）与查询值（searchParams values）与活秘密
 *   逐字相等才拒——host/path/查询键不审，子串包含不审（精确匹配防误伤）。
 * 非法 URL 由 normalizeServer 形状校验拒绝，本门解析失败即跳过（不重复判）。
 */
function checkUrl(
  url: unknown,
  liveSecrets: ReadonlyMap<string, string>,
  snapshot: Record<string, string | undefined>,
): void {
  if (typeof url !== "string" || url === "") return;
  const secretRefs = extractEnvRefs(url).filter((ref) => isSecretEnvName(ref));
  if (secretRefs.length > 0) {
    throw smuggleErrorForSlot("url", `key "url"`, secretRefs[0] as string);
  }
  const expanded = expandWithSnapshot(url, snapshot);
  if (expanded === "") return;
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    return;
  }
  for (const candidate of urlSecretCandidates(parsed)) {
    const matchedVar = liveSecrets.get(candidate);
    if (matchedVar !== undefined) {
      throw duplicateErrorForSlot(
        "url",
        `key "url"`,
        matchedVar,
        `remove the live secret from the url and pass it via headers with the template ` +
          `"\${${matchedVar}}", or stop embedding the live secret`,
      );
    }
  }
}

/**
 * url 里参与活秘密逐字比对的候选段：userinfo（username/password）与查询值；
 * host/path/查询键不审，空串不进候选。产出顺序即原判定顺序，未改判定口径。
 */
function urlSecretCandidates(parsed: URL): string[] {
  const candidates: string[] = [];
  if (parsed.username !== "") candidates.push(parsed.username);
  if (parsed.password !== "") candidates.push(parsed.password);
  for (const value of parsed.searchParams.values()) {
    if (value !== "") candidates.push(value);
  }
  return candidates;
}

/**
 * 审计 args 表（调用方保证入参是归一化后的 string[]；报错只读变量名与模板，永不回显字面量）。
 *
 * args 元素整体视为非秘密槽（无键名可判凭据形），与 env 同口径：
 * - 引用污染拦：任一元素内 ${SECRET} 引用（set/unset 皆拦，与 checkMap 同口径）；
 * - 活秘密查重：元素展开值（或 `--flag=<值>` 等号后段）与活秘密逐字相等才拒——
 *   如 `--token <活值>` 的独立元素形态与 `--token=<活值>` 形态；子串包含不审
 *   （精确匹配防误伤：含活值的长串、粘连形态一律放行，宁漏此类构造，不误伤正当参数）。
 */
function checkArgs(
  args: unknown,
  liveSecrets: ReadonlyMap<string, string>,
  snapshot: Record<string, string | undefined>,
): void {
  if (!Array.isArray(args)) return;
  args.forEach((entry, index) => {
    const raw = String(entry);
    const secretRefs = extractEnvRefs(raw).filter((ref) => isSecretEnvName(ref));
    if (secretRefs.length > 0) {
      throw smuggleErrorForSlot("args", `index ${index}`, secretRefs[0] as string);
    }
    const expanded = expandWithSnapshot(raw, snapshot);
    if (expanded === "") return;
    const candidates = [expanded];
    const eq = expanded.indexOf("=");
    if (eq !== -1) candidates.push(expanded.slice(eq + 1));
    for (const candidate of candidates) {
      if (candidate === "") continue;
      const matchedVar = liveSecrets.get(candidate);
      if (matchedVar !== undefined) {
        throw duplicateErrorForSlot(
          "args",
          `index ${index}`,
          matchedVar,
          `replace the value with the template "\${${matchedVar}}" so only the reference is stored, ` +
            `or stop passing the live secret here`,
        );
      }
    }
  });
}

/**
 * 写边界凭据策略门（add / update / import 同门；normalize 保持纯形状校验不调本函数；
 * registerServer 内存态不调本函数，见 manager.registerServer 注释）。
 *
 * @param env 归一化后的 env 表（add/update 传 normalize 产物；import 经 parseClaudeJson →
 *   manager.add/update 间接同门，不直调）。
 * @param headers 归一化后的 headers 表。
 * @param snapshot 父环境快照（缺省 process.env；单测注入隔离快照，离线可跑）。
 * @param url 归一化后的 url（只审 userinfo/查询值中的活秘密值 + 引用污染；缺省跳过）。
 * @param args 归一化后的 args（只审秘密 flag 值等于活秘密值 + 引用污染；缺省跳过）。
 * @throws 命中即抛错（fail-closed）：文案含哪个键/槽位、为什么被拒、怎么改；不含字面量值
 *   （400 body 经 redactError 原样返回，被拒配置不在脱敏快照内，回显即泄漏）。
 */
export function assertEnvPolicy(
  env: Record<string, unknown> | undefined,
  headers: Record<string, unknown> | undefined,
  snapshot: Record<string, string | undefined> = process.env,
  url?: unknown,
  args?: unknown,
): void {
  // 活秘密值表：凭据形（精确判定，非子串）且非空的父环境变量 值 → 变量名。
  // TURKEY_SIZE 这类纵使在父环境里有值，也不进表（名先被 isSecretEnvName 判否）。
  const liveSecrets = new Map<string, string>();
  for (const [varName, varValue] of Object.entries(snapshot)) {
    if (typeof varValue !== "string" || varValue === "") continue;
    if (!isSecretEnvName(varName)) continue;
    if (!liveSecrets.has(varValue)) liveSecrets.set(varValue, varName);
  }
  checkMap("env", env, liveSecrets, snapshot);
  checkMap("headers", headers, liveSecrets, snapshot);
  checkUrl(url, liveSecrets, snapshot);
  checkArgs(args, liveSecrets, snapshot);
}
