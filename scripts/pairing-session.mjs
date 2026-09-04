#!/usr/bin/env node
import process from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { startPairingHarness } from "../core/pairing-harness.mjs";
const [command, instanceId, ...extra] = process.argv.slice(2);
if (command !== "start" || !instanceId || extra.length) process.exit(2);
const runtimeRoot = process.env.BROWSER_POC_RUNTIME_ROOT ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT) : path.resolve(import.meta.dirname, "..", ".runtime");
let harness;
try { harness = await startPairingHarness({ runtimeRoot, instanceId }); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
process.stdout.write(`ready ${instanceId} ISSUED\n`);
const stop = async () => { await harness.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line === "status") process.stdout.write(`status ${instanceId} ${harness.server.state.phase}\n`);
  else if (line === "ping") { try { await harness.server.requestPing({ requestId: randomUUID(), timeoutMs: 1000 }); process.stdout.write("ping ok\n"); } catch { process.stdout.write("ping failed\n"); } }
  else if (line === "quit") break;
  else process.stdout.write("error unknown_command\n");
}
await stop();
