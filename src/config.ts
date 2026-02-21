import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Config {
  port: number;
  host: string;
  storageDir: string;
  storagePeers: string[];
}

/** Default path for the agora-relay home directory */
export const AGORA_HOME = path.join(os.homedir(), ".agora-relay");

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Parse a .env file into a key-value map. Lines starting with # are ignored. */
function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes (only when both open and close quotes present)
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Load peer public keys from ~/.agora-relay/peers.json (array of strings). */
function loadPeersJson(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(data)) {
      return data.filter((k): k is string => typeof k === "string");
    }
  } catch {
    // Ignore malformed peers.json
  }
  return [];
}

/**
 * Load configuration from .env (CWD) and ~/.agora-relay/peers.json.
 * Returns defaults when neither source is present.
 */
export function loadConfig(): Config {
  const env = parseEnvFile(path.join(process.cwd(), ".env"));
  const peersFromFile = loadPeersJson(path.join(AGORA_HOME, "peers.json"));
  const peersFromEnv = (env["AGORA_STORAGE_PEERS"] || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const rawStorageDir = env["AGORA_STORAGE_DIR"];
  const defaultStorageDir = path.join(AGORA_HOME, "storage");

  const rawPort = env["AGORA_PORT"] ? parseInt(env["AGORA_PORT"], 10) : NaN;

  return {
    port: !isNaN(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 9470,
    host: env["AGORA_HOST"] || "0.0.0.0",
    storageDir: rawStorageDir ? expandHome(rawStorageDir) : defaultStorageDir,
    storagePeers: [...new Set([...peersFromFile, ...peersFromEnv])],
  };
}
