#!/usr/bin/env node

import { Relay } from "./relay.js";
import { loadConfig } from "./config.js";

interface CliArgs {
  port?: number;
  host?: string;
  storageDir?: string;
  storagePeers?: string[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};
  const extraPeers: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && i + 1 < args.length) {
      result.host = args[i + 1];
      i++;
    } else if (args[i] === "--storage-dir" && i + 1 < args.length) {
      result.storageDir = args[i + 1];
      i++;
    } else if (args[i] === "--storage-peers" && i + 1 < args.length) {
      extraPeers.push(
        ...args[i + 1].split(",").map((k) => k.trim()).filter(Boolean)
      );
      i++;
    }
  }

  if (extraPeers.length > 0) result.storagePeers = extraPeers;

  return result;
}

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return key.slice(0, 8) + "..." + key.slice(-4);
}

async function main() {
  // Load base config from .env (CWD) and ~/.agora-relay/peers.json
  const fileConfig = loadConfig();
  const cliArgs = parseArgs();

  // CLI args override file config for scalar values; peers are unioned
  const port = cliArgs.port ?? fileConfig.port;
  const host = cliArgs.host ?? fileConfig.host;
  const storageDir = cliArgs.storageDir ?? fileConfig.storageDir;
  const storagePeers = [
    ...new Set([...fileConfig.storagePeers, ...(cliArgs.storagePeers || [])]),
  ];

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
