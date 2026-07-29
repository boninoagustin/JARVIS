import { run_replay } from "./scripts/replay_harness";
import * as fs from "fs";
import { resolve } from "path";

async function main() {
    const ohlcvPath = resolve(__dirname, "logs/eurusd/pine-logs-Exportador OHLCV Gratis_be777.csv");
    const pinePath = resolve(__dirname, "logs/eurusd/pine-logs-SMC Master 5.2 [JARVIS v6.0]_ae454.csv");
    const { engineLogs } = await run_replay(ohlcvPath, pinePath, 60, false);
    fs.writeFileSync("engine_h1_logs.csv", engineLogs.join("\n"));
    console.log("Saved engine logs to engine_h1_logs.csv");
}
main().catch(console.error);
