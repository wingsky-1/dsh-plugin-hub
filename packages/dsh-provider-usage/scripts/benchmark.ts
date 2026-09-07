import { HistoryStore } from "./packages/dsh-provider-usage/src/core/history.ts";
import { rm, mkdir } from "fs/promises";
import { join } from "path";

async function main() {
    const root = join(process.cwd(), "benchmark_history");
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await mkdir(root, { recursive: true });

    const store = new HistoryStore({ root });
    const provider = "testProvider";
    const name = "testName";

    const baseTime = new Date('2024-01-01T00:00:00Z').getTime();

    // Create 365 days of data
    for (let i = 0; i < 365; i++) {
        const time = baseTime + i * 86400000;
        await store.append(provider, name, { time, data: { value: i } });
    }

    let minDuration = Infinity;
    // 5 iterations
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await store.query(provider, name, { start: baseTime, end: baseTime + 364 * 86400000 });
      const end = performance.now();
      minDuration = Math.min(minDuration, end - start);
    }

    console.log(`Baseline Query took ${minDuration.toFixed(2)} ms`);

    await rm(root, { recursive: true, force: true }).catch(() => {});
}

main().catch(console.error);
