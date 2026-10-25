import type {
  DnsAnswer,
  PinnedOutcome,
  PinnedTransport,
} from "../../../src/server/channels/impl/dry-run/secure-fetch.ts";

export function stubDns(table: Record<string, DnsAnswer[]>): {
  resolveAll: (host: string) => Promise<DnsAnswer[]>;
} {
  return {
    resolveAll: (host: string) => Promise.resolve(table[host] ?? []),
  };
}
export function stubTransport(script: PinnedOutcome[]): {
  transport: PinnedTransport;
  calls: string[];
} {
  const calls: string[] = [];
  let step = 0;
  const transport: PinnedTransport = (url, ip) => {
    calls.push(url.toString() + " @" + ip);
    const outcome = script[Math.min(step, script.length - 1)];
    step += 1;
    if (outcome === undefined) throw new Error("桩建连剧本耗尽");
    return Promise.resolve(outcome);
  };
  return { transport, calls };
}
export const INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  timeoutMs: 1000,
};
