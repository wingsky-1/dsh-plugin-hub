// @ts-nocheck
/**
 * dsh-notifier — unit：错误文本脱敏（sanitizeErrorText）。
 *
 * 覆盖：路径/令牌/密钥打码 + 截断；issue #6 扩展（GitHub PAT / PEM 私钥 /
 * 连接串凭据 / 邮箱）；规则顺序硬约束回归；FP 证伪回归（已删规则的误伤
 * 形态必须保持原样）；性能护栏（防灾难性回溯）；PEM 限窗/赋值分隔符/amqps
 * 评审修复回归。
 */
import { assert } from "./helpers.ts";
import { sanitizeErrorText } from "../src/index.ts";

// 路径/令牌/密钥打码 + 截断
assert.equal(sanitizeErrorText("failed /home/me/dev/x.yaml: EACCES"), "failed <path>: EACCES", "用户路径打码");
assert.equal(sanitizeErrorText("token: 3f9a2b7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"), "token: <token>", "长 hex 令牌打码");
assert.ok(!sanitizeErrorText("password=s3cr3t").includes("s3cr3t"), "密钥赋值掩蔽");
assert.equal(sanitizeErrorText("错".repeat(500)).length, 300, "截断 300");
assert.equal(sanitizeErrorText("普通错误"), "普通错误", "普通文本原样");
assert.equal(sanitizeErrorText("x".repeat(40)), "<token>", "长重复字符按令牌打码");

// 推送前修复（P1）：脱敏漏网补充——JWT / AKIA 前缀 / /root 路径
assert.equal(
  sanitizeErrorText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
  "Authorization=<redacted> <token>",
  "Authorization 头掩蔽 + JWT（含 - _ 的 base64url）整段打码"
);
assert.equal(sanitizeErrorText("aws key AKIAIOSFODNN7EXAMPLE used"), "aws key <token> used", "AKIA 前缀密钥打码");
assert.ok(!sanitizeErrorText("Cannot read /root/.ssh/id_rsa: denied").includes("/root"), "/root 路径打码");
assert.ok(!sanitizeErrorText("open /etc/passwd denied").includes("/etc"), "/etc 路径打码");
// 防误伤：普通含下划线/连字符的英文单词不应被 JWT/AKIA 规则误打码
assert.equal(sanitizeErrorText("the-key_is-here and also_fine"), "the-key_is-here and also_fine", "普通文本不被 JWT 规则误伤");

// ---- issue #6 脱敏扩展：GitHub PAT / PEM 私钥 / 连接串凭据 / 邮箱 ----
// GitHub PAT classic（ghp/gho/ghu/ghs/ghr + 恰 36 位字母数字）
const patCore36 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
assert.equal(sanitizeErrorText(`token ghp_${patCore36} end`), "token <token> end", "GitHub PAT classic 打码");
for (const prefix of ["gho", "ghu", "ghs", "ghr"]) {
  assert.equal(sanitizeErrorText(`${prefix}_${patCore36}`), "<token>", `GitHub PAT ${prefix}_ 前缀打码`);
}
// 长度边界锁定：35/37 位不命中（业界共识写死长度），且不被通用长串规则部分命中
assert.equal(sanitizeErrorText(`ghp_${patCore36.slice(0, 35)}`), `ghp_${patCore36.slice(0, 35)}`, "PAT 35 位不误伤");
assert.equal(sanitizeErrorText(`ghp_${patCore36}X`), `ghp_${patCore36}X`, "PAT 37 位不误伤");
// fine-grained PAT（区间长度）
const fgPat = `github_pat_${"A".repeat(22)}_${"B".repeat(59)}`;
assert.equal(sanitizeErrorText(`bad ${fgPat}!`), "bad <token>!", "GitHub fine-grained PAT 打码");
// 回归：通用长串规则不得对 github_pat_ 部分命中产生残缺掩码
assert.ok(!sanitizeErrorText(fgPat).includes("_"), "fine-grained PAT 无残缺残留");

// PEM 私钥：完整块（含 \r\n 变体）与孤立 BEGIN 兜底；证书/PUBLIC KEY 不误伤
const pemBody = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGWyifZ6IWVpYFKEzBNGIFfD8hV0v";
assert.equal(
  sanitizeErrorText(`-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----\nok`),
  "<private-key>\nok",
  "PEM 完整私钥块打码"
);
assert.ok(
  !sanitizeErrorText(`-----BEGIN EC PRIVATE KEY-----\r\n${pemBody}\r\n-----END EC PRIVATE KEY-----`).includes("MIIEow"),
  "PEM 私钥块（\\r\\n）打码"
);
assert.ok(
  !sanitizeErrorText(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n尾随`).includes("b3BlbnNzaC"),
  "PEM 孤立 BEGIN（无 END，错误消息截断常态）兜底打码"
);
assert.equal(
  sanitizeErrorText("-----BEGIN CERTIFICATE-----\nc2hvcnRib2R5\n-----END CERTIFICATE-----"),
  "-----BEGIN CERTIFICATE-----\nc2hvcnRib2R5\n-----END CERTIFICATE-----",
  "证书块不误伤"
);
assert.ok(!sanitizeErrorText("-----BEGIN PUBLIC KEY-----\nc2hvcnRib2R5\n-----END PUBLIC KEY-----").includes("<private-key>"), "PUBLIC KEY 不误伤");

// 数据库/消息队列连接串凭据：scheme 保留、凭据整体掩蔽
assert.equal(
  sanitizeErrorText("postgres://admin:s3cret@db.local:5432/app down"),
  "postgres://<redacted>@db.local:5432/app down",
  "postgres 连接串掩蔽且 scheme 正确（防 $1 组号回归）"
);
assert.equal(sanitizeErrorText("redis://:MyPass@127.0.0.1:6379"), "redis://<redacted>@127.0.0.1:6379", "redis 空用户名形态掩蔽");
assert.equal(
  sanitizeErrorText("mongodb+srv://dev:pw123@cluster0.abc12.mongodb.net/test"),
  "mongodb+srv://<redacted>@cluster0.abc12.mongodb.net/test",
  "mongodb+srv 连接串掩蔽"
);
assert.equal(sanitizeErrorText("POSTGRES://U:P@H"), "POSTGRES://<redacted>@H", "大写 scheme 掩蔽（i flag）");
assert.equal(
  sanitizeErrorText("jdbc:mysql://host/db?user=root&password=topsecret"),
  "jdbc:mysql://host/db?user=root&password=<redacted>",
  "JDBC 凭据在 query 参数，由密钥赋值规则覆盖"
);
assert.equal(sanitizeErrorText("postgres://u:p@ss@h"), "postgres://<redacted>@ss@h", "畸形双 @ 锁定残缺行为（URL 规范要求编码）");

// 邮箱（严格版）：正常邮箱打码；资源引用/版本号不误伤
assert.equal(sanitizeErrorText("mail a.b-c@example.co.uk end"), "mail <email> end", "邮箱打码");
assert.equal(sanitizeErrorText("loaded image@2x.png"), "loaded image@2x.png", "资源引用 @2x 不误伤");
assert.equal(sanitizeErrorText("need @scope/pkg@1.2.3"), "need @scope/pkg@1.2.3", "包版本 pkg@1.2.3 不误伤");
// 顺序回归：DSN 掩蔽后占位符不得被邮箱规则二次命中产生 <<email>>
assert.equal(
  sanitizeErrorText("mysql://admin:s3cret@db.example.com down"),
  "mysql://<redacted>@db.example.com down",
  "DSN 与邮箱规则顺序回归"
);
// 尖括号引用形态（issue #30）：双断言放行 <user@host>，不再整体漏网
assert.equal(
  sanitizeErrorText("From: John <john.doe@corp.example.com> signed"),
  "From: John <<email>> signed",
  "尖括号包裹的真实邮箱正常打码"
);
// 占位符不被二次破坏（issue #30）：裸 <redacted>@真实域名 形态必须原样保留
assert.equal(
  sanitizeErrorText("<redacted>@db.example.com down"),
  "<redacted>@db.example.com down",
  "DSN 掩码占位符不被邮箱规则二次命中"
);

// 规则顺序硬约束回归
assert.equal(
  sanitizeErrorText("postgres://u:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c@h"),
  "postgres://<redacted>@h",
  "DSN 先于 JWT：连接串内嵌 JWT 整体掩蔽，用户名不残留"
);
assert.equal(
  sanitizeErrorText("postgres://u:token@hostname down"),
  "postgres://<redacted>@hostname down",
  "DSN 先于密钥赋值：host 保留、凭据不劣化残留"
);

// 边界与容错：Symbol 入参不抛错；截断窗口腰斩行为锁定
assert.doesNotThrow(() => sanitizeErrorText(Symbol("x")), "Symbol 入参不抛 TypeError");
assert.equal(sanitizeErrorText(Symbol("x")), "Symbol(x)", "Symbol 入参转字符串");
assert.equal(sanitizeErrorText("前".repeat(296) + `ghp_${patCore36}`), "前".repeat(296) + "<tok", "占位符落在截断窗口被腰斩（锁定行为）");

// FP 证伪回归：已删除规则的高频误伤形态必须保持原样（防止将来加回来）
assert.equal(sanitizeErrorText("Date.now()=1718000000000"), "Date.now()=1718000000000", "13 位毫秒时间戳原样（信用卡规则证伪）");
assert.equal(sanitizeErrorText("Chrome/120.0.0.0 Safari/537.36"), "Chrome/120.0.0.0 Safari/537.36", "UA 版本号原样（IPv4 规则证伪）");
assert.equal(sanitizeErrorText("order 1234567890123456 paid"), "order 1234567890123456 paid", "16 位订单号原样");

// 性能护栏：大文本全链无灾难性回溯（宽松上限防 CI 抖动，非基准测试）
{
  const big = "postgres://admin:s3cret@db.example.com error jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpM\n".repeat(10000);
  const t0 = Date.now();
  sanitizeErrorText(big);
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `约 1MB 文本脱敏耗时 ${cost}ms < 1000ms（防回溯退化）`);
}

// 性能护栏（对抗形态）：多 BEGIN 无 END 输入曾因完整块规则 O(k·n) 阻塞宿主数秒
// （评审实测 1MB 高密度 BEGIN 6-17s），限窗 {0,4096} 后必须保持线性量级
{
  const adversarial = "-----BEGIN PRIVATE KEY-----".repeat(20000); // 约 560KB
  const t0 = Date.now();
  const out = sanitizeErrorText(adversarial);
  const cost = Date.now() - t0;
  assert.ok(cost < 5000, `对抗输入（2 万 BEGIN 无 END）脱敏耗时 ${cost}ms < 5000ms（防 PEM 回溯回归）`);
  assert.ok(out.startsWith("<private-key>"), "对抗输入由孤立 BEGIN 兜底规则接住");
}

// ---- 评审修复回归：PEM 限窗 / 赋值分隔符收紧 / amqps ----

// PEM 完整块在窗口内仍整体打码；超窗伪块由孤立 BEGIN 兜底接住
{
  const pad = "A".repeat(5000);
  assert.equal(
    sanitizeErrorText(`-----BEGIN RSA PRIVATE KEY-----\n${pad}\n-----END RSA PRIVATE KEY-----\nok`),
    "<private-key>",
    "PEM 超 4096 窗口的真实长块：完整块失配后由兜底规则整体掩蔽到文本尾"
  );
  assert.equal(
    sanitizeErrorText("前 -----BEGIN PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- 后续可读"),
    "前 <private-key> 后续可读",
    "PEM 窗口内完整块打码且块后内容保留可读"
  );
}

// 密钥赋值规则：分隔符 [=:] 必须显式——自然语言不得误伤（评审 P1 回归）
assert.equal(sanitizeErrorText("auth failed: token expired"), "auth failed: token expired", "自然语言 token expired 不误伤");
assert.equal(sanitizeErrorText("request rejected: invalid token provided"), "request rejected: invalid token provided", "invalid token provided 不误伤");
assert.equal(sanitizeErrorText("password policy requires changes"), "password policy requires changes", "password policy 不误伤");
assert.equal(sanitizeErrorText("Authorization header missing"), "Authorization header missing", "Authorization header 不误伤");
// 显式赋值形态仍打码（含「键名: 空格 值」与引号形态）
assert.equal(sanitizeErrorText("token: abc123"), "token=<redacted>", "显式冒号赋值仍打码");
assert.equal(sanitizeErrorText('password = "s3cr3t"'), 'password=<redacted>"', "等号带空格+引号赋值仍打码（收尾引号残留为已知形态）");
assert.ok(!sanitizeErrorText("api_key=sk-live-9f8e7d6c5b4a").includes("sk-live"), "api_key= 赋值仍打码");

// amqps 连接串凭据：scheme 保留、凭据整体掩蔽（评审 P2 回归，不再半脱敏）
assert.equal(sanitizeErrorText("amqps://guest:guest@rabbit.local/vhost"), "amqps://<redacted>@rabbit.local/vhost", "amqps 连接串整体掩蔽");
assert.equal(sanitizeErrorText("AMQPS://u:p@h/v"), "AMQPS://<redacted>@h/v", "amqps 大写 scheme 掩蔽");
