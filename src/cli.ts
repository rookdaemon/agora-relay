#!/usr/bin/env node

import { Relay } from "./relay.js";

function parseArgs(): { port: number; host: string; storageDir: string; storagePeers: string[] } {
  const args = process.argv.slice(2);
  let port = 9470;
  let host = "0.0.0.0";
  let storageDir = "";
  let storagePeers: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === "--storage-dir" && i + 1 < args.length) {
      storageDir = args[i + 1];
      i++;
    } else if (args[i] === "--storage-peers" && i + 1 < args.length) {
      storagePeers = args[i + 1].split(",").map((k) => k.trim()).filter(Boolean);
      i++;
    }
  }

  return { port, host, storageDir, storagePeers };
}

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return key.slice(0, 8) + "..." + key.slice(-4);
}

async function main() {
  const { port, host, storageDir, storagePeers } = parseArgs();

  const relay = new Relay({ port, host, storageDir, storagePeers });

  relay.on("connection", (publicKey: string) => {
    console.log(`[CONNECT] ${truncateKey(publicKey)}`);
  });

  relay.on("disconnection", (publicKey: string) => {
    console.log(`[DISCONNECT] ${truncateKey(publicKey)}`);
  });

  relay.on("message", (from: string, to: string) => {
    console.log(`[MESSAGE] ${truncateKey(from)} → ${truncateKey(to)}`);
  });

  try {
    await relay.start();
    console.log(`Relay server listening on ${host}:${port}`);
  } catch (error) {
    console.error("Failed to start relay:", error);
    process.exit(1);
  }

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await relay.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\nShutting down...");
    await relay.stop();
    process.exit(0);
  });
}

main();
