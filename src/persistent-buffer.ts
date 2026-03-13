import * as fs from "fs";
import * as path from "path";

import type { BufferedMessage } from "@rookdaemon/agora";

const MAX_MESSAGES_PER_AGENT = 100;
const DEFAULT_TTL_MS = 86_400_000; // 24 hours (matches MessageBuffer default)

interface PersistedEntry {
  message: BufferedMessage;
  receivedAt: number;
}

/**
 * A file-backed implementation of the MessageBuffer interface.
 * Messages are persisted to disk so they survive relay restarts.
 * Drop-in replacement for MessageBuffer for use with createRestRouter.
 */
export class PersistentMessageBuffer {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(storageDir: string, options?: { ttlMs?: number; now?: () => number }) {
    this.dir = path.join(storageDir, "buffer");
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options?.now ?? (() => Date.now());
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(publicKey: string): string {
    return path.join(this.dir, `${encodeURIComponent(publicKey)}.json`);
  }

  private readEntries(publicKey: string): PersistedEntry[] {
    const file = this.filePath(publicKey);
    if (!fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(data)) return data as PersistedEntry[];
    } catch {
      // Ignore malformed files
    }
    return [];
  }

  private writeEntries(publicKey: string, entries: PersistedEntry[]): void {
    const file = this.filePath(publicKey);
    if (entries.length === 0) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, JSON.stringify(entries), "utf8");
    }
  }

  /**
   * Add a message to an agent's buffer.
   * Evicts the oldest message if the buffer is full (max 100).
   */
  add(publicKey: string, message: BufferedMessage): void {
    const entries = this.readEntries(publicKey);
    entries.push({ message, receivedAt: this.now() });
    if (entries.length > MAX_MESSAGES_PER_AGENT) {
      entries.shift();
    }
    this.writeEntries(publicKey, entries);
  }

  /**
   * Retrieve messages for an agent, optionally filtering by `since` timestamp.
   * Returns messages with timestamp > since (exclusive). Prunes expired messages.
   */
  get(publicKey: string, since?: number): BufferedMessage[] {
    const now = this.now();
    let entries = this.readEntries(publicKey);
    entries = entries.filter((e) => now - e.receivedAt < this.ttlMs);
    this.writeEntries(publicKey, entries);
    const messages = entries.map((e) => e.message);
    if (since === undefined) {
      return messages;
    }
    return messages.filter((m) => m.timestamp > since);
  }

  /**
   * Clear all messages for an agent (after polling without `since`).
   */
  clear(publicKey: string): void {
    this.writeEntries(publicKey, []);
  }

  /**
   * Remove all state for a disconnected agent.
   */
  delete(publicKey: string): void {
    const file = this.filePath(publicKey);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
