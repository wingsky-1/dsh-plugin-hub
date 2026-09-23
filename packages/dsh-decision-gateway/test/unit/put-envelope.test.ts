/** PUT envelope normalize (D1). */
import { describe, expect, it } from "vitest";
import { normalizePutEnvelope } from "../../src/server/config/impl/envelope.ts";
import { validatePutBody } from "../../src/server/config/impl/model.ts";

describe("nested envelope accepted", () => {
  it("version 1 plus connection keys flatten", () => {
    const r = normalizePutEnvelope({
      version: 1,
      connection: { apiKeyRef: "JEV_ENV_X", timeoutMs: 9000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat).toMatchObject({ apiKeyRef: "JEV_ENV_X", timeoutMs: 9000 });
    expect("hasPlaintextKey" in r.flat).toBe(false);
    expect(validatePutBody(r.flat).ok).toBe(true);
  });
  it("flat body passes through", () => {
    const r = normalizePutEnvelope({ apiKeyRef: "JEV_ENV_X" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat).toMatchObject({ apiKeyRef: "JEV_ENV_X" });
  });
});

describe("non-1 version rejected", () => {
  it("version 2 is INVALID_VERSION", () => {
    const r = normalizePutEnvelope({ version: 2, connection: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.errorCode).toBe("INVALID_VERSION");
    expect(r.failure.category).toBe("bad-request");
  });
  it("string version rejected", () => {
    expect(normalizePutEnvelope({ version: "1", connection: {} }).ok).toBe(false);
  });
});

describe("unknown keys 400", () => {
  it("unknown connection key is UNKNOWN_KEY", () => {
    const r = normalizePutEnvelope({ version: 1, connection: { bogus: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.errorCode).toBe("UNKNOWN_KEY");
  });
  it("unknown top key is UNKNOWN_KEY", () => {
    const r = normalizePutEnvelope({ version: 1, connection: {}, whatever: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.errorCode).toBe("UNKNOWN_KEY");
  });
});

describe("hasPlaintextKey ignored", () => {
  it("read-only key dropped, rest validates", () => {
    const r = normalizePutEnvelope({
      version: 1,
      connection: { hasPlaintextKey: true, apiKeyRef: "JEV_ENV_Y" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("hasPlaintextKey" in r.flat).toBe(false);
    expect(r.flat).toMatchObject({ apiKeyRef: "JEV_ENV_Y" });
    expect(validatePutBody(r.flat).ok).toBe(true);
  });
});
