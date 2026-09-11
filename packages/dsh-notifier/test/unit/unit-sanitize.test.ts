/**
 * dsh-notifier — unit：错误文本脱敏（sanitizeErrorText）与通知统一脱敏入口
 * （sanitizeNoticeContent）。
 *
 * 覆盖：路径/令牌/密钥打码 + 截断；脱敏扩展（GitHub PAT / PEM 私钥 /
 * 连接串凭据 / 邮箱）；规则顺序硬约束回归；FP 证伪回归（已删规则的误伤
 * 形态必须保持原样）；性能护栏（防灾难性回溯）；PEM 限窗/赋值分隔符/amqps
 * 评审修复回归；sanitizeNoticeContent 与 sanitizeErrorText 同源输出一致、
 * enabled=false 原样、undefined 开关容错、body 不截断、PEM eat-to-tail 锁定。
 */
import { describe, expect, it } from "vitest";
import { sanitizeErrorText } from "../../src/index.ts";
// sanitizeNoticeContent 不进包导出面（消费方经 SDK send 中心兜底）——
// 测试经 src 域内路径 import（同 unit-config seqFile 直连 src 姿态）。
import { sanitizeNoticeContent } from "../../src/text/interface.ts";

/** GitHub PAT classic 主体（恰 36 位字母数字）。 */
const patCore36 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** fine-grained PAT 样本（区间长度）。 */
const fgPat = `github_pat_${"A".repeat(22)}_${"B".repeat(59)}`;
/** PEM 私钥体样本。 */
const pemBody = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGWyifZ6IWVpYFKEzBNGIFfD8hV0v";

describe("路径/令牌/密钥打码 + 截断", () => {
  it("用户路径打码", () => {
    expect(sanitizeErrorText("failed /home/me/dev/x.yaml: EACCES")).toBe("failed <path>: EACCES");
  });

  it("长 hex 令牌打码", () => {
    expect(sanitizeErrorText("token: 3f9a2b7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d")).toBe("token: <token>");
  });

  it("密钥赋值掩蔽", () => {
    expect(!sanitizeErrorText("password=s3cr3t").includes("s3cr3t")).toBeTruthy();
  });

  it("截断 300", () => {
    expect(sanitizeErrorText("错".repeat(500)).length).toBe(300);
  });

  it("普通文本原样", () => {
    expect(sanitizeErrorText("普通错误")).toBe("普通错误");
  });

  it("长重复字符按令牌打码", () => {
    expect(sanitizeErrorText("x".repeat(40))).toBe("<token>");
  });
});

describe("脱敏漏网补充（推送前修复）：JWT / AKIA 前缀 / /root 路径", () => {
  it("Authorization 头掩蔽 + JWT（含 - _ 的 base64url）整段打码", () => {
    expect(
      sanitizeErrorText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")
    ).toBe("Authorization=<redacted> <token>");
  });

  it("AKIA 前缀密钥打码", () => {
    expect(sanitizeErrorText("aws key AKIAIOSFODNN7EXAMPLE used")).toBe("aws key <token> used");
  });

  it("/root 路径打码", () => {
    expect(!sanitizeErrorText("Cannot read /root/.ssh/id_rsa: denied").includes("/root")).toBeTruthy();
  });

  it("/etc 路径打码", () => {
    expect(!sanitizeErrorText("open /etc/passwd denied").includes("/etc")).toBeTruthy();
  });

  it("普通文本不被 JWT 规则误伤", () => {
    // 防误伤：普通含下划线/连字符的英文单词不应被 JWT/AKIA 规则误打码
    expect(sanitizeErrorText("the-key_is-here and also_fine")).toBe("the-key_is-here and also_fine");
  });
});

describe("脱敏扩展：GitHub PAT", () => {
  it("GitHub PAT classic 打码", () => {
    // GitHub PAT classic（ghp/gho/ghu/ghs/ghr + 恰 36 位字母数字）
    expect(sanitizeErrorText(`token ghp_${patCore36} end`)).toBe("token <token> end");
  });

  for (const prefix of ["gho", "ghu", "ghs", "ghr"]) {
    it(`GitHub PAT ${prefix}_ 前缀打码`, () => {
      expect(sanitizeErrorText(`${prefix}_${patCore36}`)).toBe("<token>");
    });
  }

  it("PAT 35 位不误伤", () => {
    // 长度边界锁定：35 位不命中（业界共识写死长度），且不被通用长串规则部分命中
    expect(sanitizeErrorText(`ghp_${patCore36.slice(0, 35)}`)).toBe(`ghp_${patCore36.slice(0, 35)}`);
  });

  it("PAT 37 位不误伤", () => {
    expect(sanitizeErrorText(`ghp_${patCore36}X`)).toBe(`ghp_${patCore36}X`);
  });

  it("GitHub fine-grained PAT 打码", () => {
    // fine-grained PAT（区间长度）
    expect(sanitizeErrorText(`bad ${fgPat}!`)).toBe("bad <token>!");
  });

  it("fine-grained PAT 无残缺残留", () => {
    // 回归：通用长串规则不得对 github_pat_ 部分命中产生残缺掩码
    expect(!sanitizeErrorText(fgPat).includes("_")).toBeTruthy();
  });
});

describe("脱敏扩展：PEM 私钥", () => {
  it("PEM 完整私钥块打码", () => {
    expect(
      sanitizeErrorText(`-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----\nok`)
    ).toBe("<private-key>\nok");
  });

  it("PEM 私钥块（\\r\\n）打码", () => {
    expect(
      !sanitizeErrorText(`-----BEGIN EC PRIVATE KEY-----\r\n${pemBody}\r\n-----END EC PRIVATE KEY-----`).includes("MIIEow")
    ).toBeTruthy();
  });

  it("PEM 孤立 BEGIN（无 END，错误消息截断常态）兜底打码", () => {
    expect(
      !sanitizeErrorText(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n尾随`).includes("b3BlbnNzaC")
    ).toBeTruthy();
  });

  it("证书块不误伤", () => {
    expect(
      sanitizeErrorText("-----BEGIN CERTIFICATE-----\nc2hvcnRib2R5\n-----END CERTIFICATE-----")
    ).toBe("-----BEGIN CERTIFICATE-----\nc2hvcnRib2R5\n-----END CERTIFICATE-----");
  });

  it("PUBLIC KEY 不误伤", () => {
    expect(
      !sanitizeErrorText("-----BEGIN PUBLIC KEY-----\nc2hvcnRib2R5\n-----END PUBLIC KEY-----").includes("<private-key>")
    ).toBeTruthy();
  });
});

describe("脱敏扩展：连接串凭据", () => {
  it("postgres 连接串掩蔽且 scheme 正确（防 $1 组号回归）", () => {
    expect(sanitizeErrorText("postgres://admin:s3cret@db.local:5432/app down")).toBe("postgres://<redacted>@db.local:5432/app down");
  });

  it("redis 空用户名形态掩蔽", () => {
    expect(sanitizeErrorText("redis://:MyPass@127.0.0.1:6379")).toBe("redis://<redacted>@127.0.0.1:6379");
  });

  it("mongodb+srv 连接串掩蔽", () => {
    expect(sanitizeErrorText("mongodb+srv://dev:pw123@cluster0.abc12.mongodb.net/test")).toBe("mongodb+srv://<redacted>@cluster0.abc12.mongodb.net/test");
  });

  it("大写 scheme 掩蔽（i flag）", () => {
    expect(sanitizeErrorText("POSTGRES://U:P@H")).toBe("POSTGRES://<redacted>@H");
  });

  it("JDBC 凭据在 query 参数，由密钥赋值规则覆盖", () => {
    expect(sanitizeErrorText("jdbc:mysql://host/db?user=root&password=topsecret")).toBe("jdbc:mysql://host/db?user=root&password=<redacted>");
  });

  it("畸形双 @ 锁定残缺行为（URL 规范要求编码）", () => {
    expect(sanitizeErrorText("postgres://u:p@ss@h")).toBe("postgres://<redacted>@ss@h");
  });
});

describe("脱敏扩展：邮箱", () => {
  it("邮箱打码", () => {
    // 邮箱（严格版）：正常邮箱打码
    expect(sanitizeErrorText("mail a.b-c@example.co.uk end")).toBe("mail <email> end");
  });

  it("资源引用 @2x 不误伤", () => {
    expect(sanitizeErrorText("loaded image@2x.png")).toBe("loaded image@2x.png");
  });

  it("包版本 pkg@1.2.3 不误伤", () => {
    expect(sanitizeErrorText("need @scope/pkg@1.2.3")).toBe("need @scope/pkg@1.2.3");
  });

  it("DSN 与邮箱规则顺序回归", () => {
    // 顺序回归：DSN 掩蔽后占位符不得被邮箱规则二次命中产生 <<email>>
    expect(sanitizeErrorText("mysql://admin:s3cret@db.example.com down")).toBe("mysql://<redacted>@db.example.com down");
  });

  it("尖括号包裹的真实邮箱正常打码", () => {
    // 尖括号引用形态：双断言放行 <user@host>，不再整体漏网
    expect(sanitizeErrorText("From: John <john.doe@corp.example.com> signed")).toBe("From: John <<email>> signed");
  });

  it("DSN 掩码占位符不被邮箱规则二次命中", () => {
    // 占位符不被二次破坏：裸 <redacted>@真实域名 形态必须原样保留
    expect(sanitizeErrorText("<redacted>@db.example.com down")).toBe("<redacted>@db.example.com down");
  });
});

describe("规则顺序硬约束回归", () => {
  it("DSN 先于 JWT：连接串内嵌 JWT 整体掩蔽，用户名不残留", () => {
    expect(
      sanitizeErrorText("postgres://u:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c@h")
    ).toBe("postgres://<redacted>@h");
  });

  it("DSN 先于密钥赋值：host 保留、凭据不劣化残留", () => {
    expect(sanitizeErrorText("postgres://u:token@hostname down")).toBe("postgres://<redacted>@hostname down");
  });
});

describe("边界与容错", () => {
  it("Symbol 入参不抛 TypeError", () => {
    expect(() => sanitizeErrorText(Symbol("x"))).not.toThrow();
  });

  it("Symbol 入参转字符串", () => {
    expect(sanitizeErrorText(Symbol("x"))).toBe("Symbol(x)");
  });

  it("占位符落在截断窗口被腰斩（锁定行为）", () => {
    expect(sanitizeErrorText("前".repeat(296) + `ghp_${patCore36}`)).toBe("前".repeat(296) + "<tok");
  });
});

describe("FP 证伪回归：已删除规则的高频误伤形态必须保持原样", () => {
  it("13 位毫秒时间戳原样（信用卡规则证伪）", () => {
    expect(sanitizeErrorText("Date.now()=1718000000000")).toBe("Date.now()=1718000000000");
  });

  it("UA 版本号原样（IPv4 规则证伪）", () => {
    expect(sanitizeErrorText("Chrome/120.0.0.0 Safari/537.36")).toBe("Chrome/120.0.0.0 Safari/537.36");
  });

  it("16 位订单号原样", () => {
    expect(sanitizeErrorText("order 1234567890123456 paid")).toBe("order 1234567890123456 paid");
  });
});

describe("性能护栏：大文本全链无灾难性回溯（宽松上限防 CI 抖动，非基准测试）", () => {
  it("约 1MB 文本脱敏耗时 < 1000ms（防回溯退化）", () => {
    const big = "postgres://admin:s3cret@db.example.com error jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpM\n".repeat(10000);
    const t0 = Date.now();
    sanitizeErrorText(big);
    const cost = Date.now() - t0;
    expect(cost < 1000).toBeTruthy();
  });
});

// 性能护栏（对抗形态）：多 BEGIN 无 END 输入曾因完整块规则 O(k·n) 阻塞宿主数秒
// （评审实测 1MB 高密度 BEGIN 6-17s），限窗 {0,4096} 后必须保持线性量级
describe("性能护栏（对抗形态）：多 BEGIN 无 END 输入限窗后线性", () => {
  function runAdversarial(): { cost: number; out: string } {
    const adversarial = "-----BEGIN PRIVATE KEY-----".repeat(20000); // 约 560KB
    const t0 = Date.now();
    const result = sanitizeErrorText(adversarial);
    return { cost: Date.now() - t0, out: result };
  }

  it("对抗输入（2 万 BEGIN 无 END）脱敏耗时 < 5000ms（防 PEM 回溯回归）", () => {
    expect(runAdversarial().cost < 5000).toBeTruthy();
  });

  it("对抗输入由孤立 BEGIN 兜底规则接住", () => {
    expect(runAdversarial().out.startsWith("<private-key>")).toBeTruthy();
  });
});

describe("评审修复回归：PEM 限窗", () => {
  it("PEM 超 4096 窗口的真实长块：完整块失配后由兜底规则整体掩蔽到文本尾", () => {
    // PEM 完整块在窗口内仍整体打码；超窗伪块由孤立 BEGIN 兜底接住
    const pad = "A".repeat(5000);
    expect(sanitizeErrorText(`-----BEGIN RSA PRIVATE KEY-----\n${pad}\n-----END RSA PRIVATE KEY-----\nok`)).toBe("<private-key>");
  });

  it("PEM 窗口内完整块打码且块后内容保留可读", () => {
    expect(sanitizeErrorText("前 -----BEGIN PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- 后续可读")).toBe("前 <private-key> 后续可读");
  });
});

describe("评审修复回归：密钥赋值分隔符 [=:] 必须显式", () => {
  it("自然语言 token expired 不误伤", () => {
    expect(sanitizeErrorText("auth failed: token expired")).toBe("auth failed: token expired");
  });

  it("invalid token provided 不误伤", () => {
    expect(sanitizeErrorText("request rejected: invalid token provided")).toBe("request rejected: invalid token provided");
  });

  it("password policy 不误伤", () => {
    expect(sanitizeErrorText("password policy requires changes")).toBe("password policy requires changes");
  });

  it("Authorization header 不误伤", () => {
    expect(sanitizeErrorText("Authorization header missing")).toBe("Authorization header missing");
  });

  it("显式冒号赋值仍打码", () => {
    // 显式赋值形态仍打码（含「键名: 空格 值」与引号形态）
    expect(sanitizeErrorText("token: abc123")).toBe("token=<redacted>");
  });

  it("等号带空格+引号赋值仍打码（收尾引号残留为已知形态）", () => {
    expect(sanitizeErrorText('password = "s3cr3t"')).toBe('password=<redacted>"');
  });

  it("api_key= 赋值仍打码", () => {
    expect(!sanitizeErrorText("api_key=sk-live-9f8e7d6c5b4a").includes("sk-live")).toBeTruthy();
  });
});

describe("评审修复回归：amqps 连接串凭据", () => {
  it("amqps 连接串整体掩蔽", () => {
    expect(sanitizeErrorText("amqps://guest:guest@rabbit.local/vhost")).toBe("amqps://<redacted>@rabbit.local/vhost");
  });

  it("amqps 大写 scheme 掩蔽", () => {
    expect(sanitizeErrorText("AMQPS://u:p@h/v")).toBe("AMQPS://<redacted>@h/v");
  });
});

describe("sanitizeNoticeContent：同源输出一致（统一脱敏入口，不进包导出面）", () => {
  const sample = { title: "任务 token: abc123 泄漏", body: "postgres://admin:s3cret@db.local down 联系 admin@corp.example.com" };

  // 同源输出一致：title 走 sanitizeErrorText(title,64)、body 走同一规则表（不截断）
  it("title 与 sanitizeErrorText(title,64) 输出一致（同一规则表同源）", () => {
    expect(sanitizeNoticeContent(sample, true).title).toBe(sanitizeErrorText(sample.title, 64));
  });

  it("body 与全长 sanitizeErrorText 输出一致（同一规则表，不截断）", () => {
    expect(sanitizeNoticeContent(sample, true).body).toBe(sanitizeErrorText(sample.body, sample.body.length + 10));
  });

  it("body 连接串凭据打码", () => {
    const result = sanitizeNoticeContent(sample, true);
    expect(!result.body.includes("s3cret")).toBeTruthy();
  });

  it("body 邮箱打码", () => {
    const result = sanitizeNoticeContent(sample, true);
    expect(!result.body.includes("admin@")).toBeTruthy();
  });
});

describe("sanitizeNoticeContent：enabled=false 标题与正文原样 String 返回（明文）", () => {
  const withSecret = { title: "任务", body: "password=s3cr3t 联系 admin@corp.example.com" };

  it("false 标题原样", () => {
    expect(sanitizeNoticeContent(withSecret, false).title).toBe("任务");
  });

  it("false 正文原样（明文）", () => {
    expect(sanitizeNoticeContent(withSecret, false).body).toBe(withSecret.body);
  });
});

describe("sanitizeNoticeContent：undefined 开关容错（调用方 `!== false` 语义）", () => {
  const withToken = { title: "任务", body: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end" };

  it("undefined 开关按启用处理（脱敏）", () => {
    expect(!sanitizeNoticeContent(withToken, undefined).body.includes("ghp_")).toBeTruthy();
  });

  it("undefined 开关打码结果与启用一致", () => {
    expect(sanitizeNoticeContent(withToken, undefined).body).toBe("token: <token> end");
  });
});

describe("sanitizeNoticeContent：body 不截断长文本（长度权威唯一 = deliver 的 capabilities.maxBodyLen）", () => {
  const longBody = "错".repeat(600) + " token: abc123";

  it("body 不截断长文本（>600 字符全长保留，不应用 300 截断）", () => {
    expect(sanitizeNoticeContent({ title: "任务", body: longBody }, true).body.length).toBe(617);
  });

  it("长文本尾部敏感特征仍打码", () => {
    expect(sanitizeNoticeContent({ title: "任务", body: longBody }, true).body.endsWith(" token=<redacted>")).toBeTruthy();
  });
});

describe("sanitizeNoticeContent：PEM eat-to-tail 不截断形态锁定", () => {
  it("PEM eat-to-tail 不截断形态锁定（全长 >300 保留）", () => {
    // 行尾 BEGIN 无 END，>300 字全长保留 + 整体打码
    const body = "错".repeat(290) + "\n-----BEGIN PRIVATE KEY-----\nMIIEow";
    expect(sanitizeNoticeContent({ title: "t", body }, true).body).toBe("错".repeat(290) + "\n<private-key>");
  });
});
