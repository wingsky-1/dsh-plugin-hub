/** #1168 冷启动 force 重建时的最新配置动态场景。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import { mountLedger } from "../../src/server/servers/lifecycle/interface.ts";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import {
  McpMiddleware,
  coldStartShape,
  makeHost,
  makeUnit,
  remoteEntry,
  trackMw,
} from "./middleware-shape-cold-start-fixture.ts";

export function registerColdStartLatestConfigCases() {
  it.each([
    {
      label: "移除",
      nextServers: undefined,
      expectedMountCommand: undefined,
    },
    {
      label: "禁用",
      nextServers: [
        {
          name: "echo",
          transport: "stdio",
          command: "node",
          enabled: false,
        } satisfies ServerConfig,
      ],
      expectedMountCommand: undefined,
    },
    {
      label: "改配置",
      nextServers: [
        {
          name: "echo",
          transport: "stdio",
          command: "changed-node",
          enabled: true,
        } satisfies ServerConfig,
      ],
      expectedMountCommand: "changed-node",
    },
  ])(
    "旧代际处置等待期间配置$label：处置后重读并只按最新配置装载",
    async ({ nextServers, expectedMountCommand }) => {
      const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-dispose-config-"));
      const root = join(dir, "project");
      const initialServer: ServerConfig = {
        name: "echo",
        transport: "stdio",
        command: "node",
        enabled: true,
      };
      let currentServers: ServerConfig[] | undefined = [initialServer];
      let configReads = 0;
      let enteredDispose!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredDispose = resolve;
      });
      let releaseDispose!: () => void;
      const disposeGate = new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
      const { host } = makeHost();
      host.projectServersFor = async (requestedRoot: string) => {
        if (requestedRoot !== root) return [];
        configReads += 1;
        return currentServers;
      };
      const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
      const ledgerEntry = mountLedger.mount("id-existing", coldStartShape.officialModule, {});
      ledgerEntry.handle.dispose = async () => {
        enteredDispose();
        await disposeGate;
      };
      const existing = remoteEntry(initialServer, "id-existing", {
        handle: ledgerEntry.handle,
      });
      const unit = makeUnit({ root, connections: new Map([["echo", existing]]) });
      mw.units.set(root, unit);
      const poolLoader = coldStartShape.poolLoader;
      const callsBefore = poolLoader.calls.length;
      let pending: Promise<void> | undefined;

      try {
        pending = mw.ensureConnected(root, "echo", { force: true });
        await entered;
        currentServers = nextServers;
        releaseDispose();
        await pending;

        expect(configReads).toBe(2);
        const mounts = poolLoader.calls
          .slice(callsBefore)
          .filter((call) => call[0] === "mount")
          .map((call) => call[2] as { command?: string });
        expect(mounts.map((config) => config.command)).toEqual(
          expectedMountCommand === undefined ? [] : [expectedMountCommand],
        );
      } finally {
        releaseDispose();
        await Promise.allSettled(pending === undefined ? [] : [pending]);
        await mw.dispose();
        catalogDirectory.dropRoot(root);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
