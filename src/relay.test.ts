import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RelayServer,
  MessageStore,
  generateKeyPair,
  createEnvelope,
} from "@rookdaemon/agora";
import { PersistentMessageBuffer } from "./persistent-buffer.js";
import WebSocket from "ws";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("RelayServer", () => {
  let relay: RelayServer;
  const testPort = 9471;

  beforeEach(async () => {
    relay = new RelayServer();
    await relay.start(testPort);
  });

  afterEach(async () => {
    await relay.stop();
  });

  it("should start and stop successfully", async () => {
    expect(relay).toBeDefined();
  });

  it("should allow client registration", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "register", publicKey: "test-key-123" }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        expect(msg.type).toBe("registered");
        expect(msg.publicKey).toBe("test-key-123");
        ws.close();
        resolve();
      });

      ws.on("error", reject);

      setTimeout(() => reject(new Error("Timeout")), 3000);
    });
  });

  it("should emit agent-registered event on registration", async () => {
    const connectionPromise = new Promise<string>((resolve) => {
      relay.on("agent-registered", (publicKey) => {
        resolve(publicKey);
      });
    });

    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "register", publicKey: "test-key-456" }));
        resolve();
      });
    });

    const connectedKey = await connectionPromise;
    expect(connectedKey).toBe("test-key-456");
    ws.close();
  });

  it("should route messages between two clients with valid envelopes", async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const envelope = createEnvelope(
      "publish",
      alice.publicKey,
      alice.privateKey,
      { text: "hello bob" },
      Date.now(),
      undefined,
      [bob.publicKey]
    );

    const client1 = new WebSocket(`ws://localhost:${testPort}`);
    const client2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => client1.on("open", resolve)),
      new Promise<void>((resolve) => client2.on("open", resolve)),
    ]);

    const client1RegisterPromise = new Promise<void>((resolve) => {
      client1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    client1.send(
      JSON.stringify({
        type: "register",
        publicKey: alice.publicKey,
      })
    );
    await client1RegisterPromise;

    const client2RegisterPromise = new Promise<void>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    client2.send(
      JSON.stringify({
        type: "register",
        publicKey: bob.publicKey,
      })
    );
    await client2RegisterPromise;

    const messagePromise = new Promise<any>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "message") resolve(msg);
      });
    });

    client1.send(
      JSON.stringify({
        type: "message",
        to: bob.publicKey,
        envelope,
      })
    );

    const receivedMsg = await messagePromise;
    expect(receivedMsg.type).toBe("message");
    expect(receivedMsg.from).toBe(alice.publicKey);
    expect(receivedMsg.envelope.payload).toEqual({ text: "hello bob" });

    client1.close();
    client2.close();
  });

  it("should return error when sending before registration", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const errorPromise = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") resolve(msg);
      });
    });

    ws.send(
      JSON.stringify({ type: "message", to: "someone", envelope: {} })
    );

    const error = await errorPromise;
    expect(error.type).toBe("error");
    expect(error.message).toMatch(/not registered/i);

    ws.close();
  });

  it("should return error for unknown recipient", async () => {
    const alice = generateKeyPair();
    const envelope = createEnvelope(
      "publish",
      alice.publicKey,
      alice.privateKey,
      {},
      Date.now(),
      undefined,
      ["unknown-recipient-key"]
    );

    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const registerPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    ws.send(
      JSON.stringify({ type: "register", publicKey: alice.publicKey })
    );
    await registerPromise;

    const errorPromise = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") resolve(msg);
      });
    });

    ws.send(
      JSON.stringify({
        type: "message",
        to: "unknown-recipient-key",
        envelope,
      })
    );

    const error = await errorPromise;
    expect(error.type).toBe("error");
    expect(error.message).toMatch(/not connected/i);

    ws.close();
  });

  it("should allow multiple sessions for the same public key", async () => {
    const client1 = new WebSocket(`ws://localhost:${testPort}`);
    const client2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => client1.on("open", resolve)),
      new Promise<void>((resolve) => client2.on("open", resolve)),
    ]);

    // Register client1 with pubkey "duplicate"
    const client1Registered = new Promise<any>((resolve) => {
      client1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve(msg);
      });
    });
    client1.send(JSON.stringify({ type: "register", publicKey: "duplicate" }));
    const msg1 = await client1Registered;
    expect(msg1.sessionId).toBeTruthy();

    // Register client2 with the same pubkey - both should stay connected
    const client2Registered = new Promise<any>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve(msg);
      });
    });
    client2.send(JSON.stringify({ type: "register", publicKey: "duplicate" }));
    const msg2 = await client2Registered;
    expect(msg2.sessionId).toBeTruthy();

    // The two sessions should have different session IDs
    expect(msg1.sessionId).not.toBe(msg2.sessionId);

    // Both clients should still be open
    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);

    client1.close();
    client2.close();
  });

  it("should deliver messages to all sessions of the recipient", async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const envelope = createEnvelope(
      "publish",
      alice.publicKey,
      alice.privateKey,
      { text: "hello all sessions" },
      Date.now(),
      undefined,
      [bob.publicKey]
    );

    const sender = new WebSocket(`ws://localhost:${testPort}`);
    const recipient1 = new WebSocket(`ws://localhost:${testPort}`);
    const recipient2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => sender.on("open", resolve)),
      new Promise<void>((resolve) => recipient1.on("open", resolve)),
      new Promise<void>((resolve) => recipient2.on("open", resolve)),
    ]);

    const senderReady = new Promise<void>((resolve) => {
      sender.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    sender.send(JSON.stringify({ type: "register", publicKey: alice.publicKey }));
    await senderReady;

    const r1Ready = new Promise<void>((resolve) => {
      recipient1.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    recipient1.send(JSON.stringify({ type: "register", publicKey: bob.publicKey }));
    await r1Ready;

    const r2Ready = new Promise<void>((resolve) => {
      recipient2.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    recipient2.send(JSON.stringify({ type: "register", publicKey: bob.publicKey }));
    await r2Ready;

    const r1Messages: any[] = [];
    const r2Messages: any[] = [];
    recipient1.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "message") r1Messages.push(msg);
    });
    recipient2.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "message") r2Messages.push(msg);
    });

    sender.send(JSON.stringify({ type: "message", to: bob.publicKey, envelope }));

    await new Promise((r) => setTimeout(r, 100));

    expect(r1Messages).toHaveLength(1);
    expect(r1Messages[0].envelope.payload).toEqual({ text: "hello all sessions" });
    expect(r2Messages).toHaveLength(1);
    expect(r2Messages[0].envelope.payload).toEqual({ text: "hello all sessions" });

    sender.close();
    recipient1.close();
    recipient2.close();
  });

  it("should send peer_offline only when the last session disconnects", async () => {
    const observer = new WebSocket(`ws://localhost:${testPort}`);
    const session1 = new WebSocket(`ws://localhost:${testPort}`);
    const session2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => observer.on("open", resolve)),
      new Promise<void>((resolve) => session1.on("open", resolve)),
      new Promise<void>((resolve) => session2.on("open", resolve)),
    ]);

    const observerReady = new Promise<void>((resolve) => {
      observer.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    observer.send(JSON.stringify({ type: "register", publicKey: "observer" }));
    await observerReady;

    const s1Ready = new Promise<void>((resolve) => {
      session1.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    session1.send(JSON.stringify({ type: "register", publicKey: "multi" }));
    await s1Ready;

    const s2Ready = new Promise<void>((resolve) => {
      session2.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    session2.send(JSON.stringify({ type: "register", publicKey: "multi" }));
    await s2Ready;

    // Track events received by observer
    const observerEvents: any[] = [];
    observer.on("message", (data) => observerEvents.push(JSON.parse(data.toString())));

    // Close first session — peer_offline should NOT be sent yet
    session1.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(observerEvents.filter((m) => m.type === "peer_offline")).toHaveLength(0);

    // Close second (last) session — peer_offline should now be sent
    session2.close();
    await new Promise((r) => setTimeout(r, 100));
    const offlineEvents = observerEvents.filter((m) => m.type === "peer_offline");
    expect(offlineEvents).toHaveLength(1);
    expect(offlineEvents[0].publicKey).toBe("multi");

    observer.close();
  });

  it("should include sessionId in the registered response", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const registeredPromise = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve(msg);
      });
    });
    ws.send(JSON.stringify({ type: "register", publicKey: "session-test" }));

    const registeredMsg = await registeredPromise;
    expect(registeredMsg.sessionId).toBeTruthy();
    expect(typeof registeredMsg.sessionId).toBe("string");

    ws.close();
  });

  it("should emit disconnection event when client disconnects", async () => {
    const disconnectionPromise = new Promise<string>((resolve) => {
      relay.on("disconnection", (publicKey) => {
        resolve(publicKey);
      });
    });

    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const registerPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    ws.send(
      JSON.stringify({ type: "register", publicKey: "disconnect-test" })
    );
    await registerPromise;

    ws.close();

    const disconnectedKey = await disconnectionPromise;
    expect(disconnectedKey).toBe("disconnect-test");
  });

  it("should respond to ping with pong", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const registerPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "register", publicKey: "ping-test" }));
    await registerPromise;

    const pongPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "ping" }));

    await pongPromise;
    ws.close();
  });
});

describe("MessageStore", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agora-relay-test-")
    );
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("should save and load messages for a recipient", () => {
    const store = new MessageStore(storageDir);
    store.save("alice", { from: "bob", envelope: { data: "hello" } });
    const messages = store.load("alice");
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("bob");
    expect(messages[0].envelope).toEqual({ data: "hello" });
  });

  it("should return empty array when no messages stored", () => {
    const store = new MessageStore(storageDir);
    expect(store.load("nobody")).toEqual([]);
  });

  it("should clear stored messages after delivery", () => {
    const store = new MessageStore(storageDir);
    store.save("alice", { from: "bob", envelope: { data: "hello" } });
    store.clear("alice");
    expect(store.load("alice")).toEqual([]);
  });

  it("should preserve message order (FIFO)", async () => {
    const store = new MessageStore(storageDir);
    store.save("alice", { from: "bob", envelope: { seq: 1 } });
    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 5));
    store.save("alice", { from: "bob", envelope: { seq: 2 } });
    const messages = store.load("alice");
    expect(messages).toHaveLength(2);
    expect((messages[0].envelope as any).seq).toBe(1);
    expect((messages[1].envelope as any).seq).toBe(2);
  });
});

describe("PersistentMessageBuffer", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agora-pbuffer-test-")
    );
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("should return empty array for a new recipient", () => {
    const buf = new PersistentMessageBuffer(storageDir);
    expect(buf.get("alice")).toEqual([]);
  });

  it("should persist messages to disk and reload on re-instantiation", () => {
    const msg = { id: "m1", from: "bob", type: "publish", payload: { text: "hi" }, timestamp: 1000 };
    const buf1 = new PersistentMessageBuffer(storageDir);
    buf1.add("alice", msg);

    const buf2 = new PersistentMessageBuffer(storageDir);
    const loaded = buf2.get("alice");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(msg);
  });

  it("should filter messages by since timestamp", () => {
    const buf = new PersistentMessageBuffer(storageDir);
    buf.add("alice", { id: "m1", from: "bob", type: "publish", payload: {}, timestamp: 100 });
    buf.add("alice", { id: "m2", from: "bob", type: "publish", payload: {}, timestamp: 200 });
    buf.add("alice", { id: "m3", from: "bob", type: "publish", payload: {}, timestamp: 300 });

    const result = buf.get("alice", 150);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("m2");
    expect(result[1].id).toBe("m3");
  });

  it("should clear stored messages for a recipient", () => {
    const buf = new PersistentMessageBuffer(storageDir);
    buf.add("alice", { id: "m1", from: "bob", type: "publish", payload: {}, timestamp: 1000 });
    buf.clear("alice");
    expect(buf.get("alice")).toEqual([]);
  });

  it("should delete all state for a recipient", () => {
    const buf = new PersistentMessageBuffer(storageDir);
    buf.add("alice", { id: "m1", from: "bob", type: "publish", payload: {}, timestamp: 1000 });
    buf.delete("alice");
    const buf2 = new PersistentMessageBuffer(storageDir);
    expect(buf2.get("alice")).toEqual([]);
  });

  it("should evict the oldest message when at capacity", () => {
    const buf = new PersistentMessageBuffer(storageDir);
    for (let i = 1; i <= 101; i++) {
      buf.add("alice", { id: `m${i}`, from: "bob", type: "publish", payload: {}, timestamp: i });
    }
    const messages = buf.get("alice");
    expect(messages).toHaveLength(100);
    expect(messages[0].id).toBe("m2");
    expect(messages[99].id).toBe("m101");
  });

  it("should prune expired messages on get", () => {
    let fakeNow = 1_000_000;
    const buf = new PersistentMessageBuffer(storageDir, {
      ttlMs: 1000,
      now: () => fakeNow,
    });
    buf.add("alice", { id: "m1", from: "bob", type: "publish", payload: {}, timestamp: 1000 });

    // Advance clock past TTL
    fakeNow += 1001;
    const messages = buf.get("alice");
    expect(messages).toHaveLength(0);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-config-test-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return defaults when no .env or peers.json", async () => {
    const { loadConfig, AGORA_HOME } = await import("./config.js");
    const config = loadConfig(tmpDir);
    expect(config.port).toBe(9470);
    expect(config.host).toBe("0.0.0.0");
    expect(config.storageDir).toBe(path.join(AGORA_HOME, "storage"));
    expect(config.storagePeers).toEqual([]);
  });

  it("should read port, host, storageDir from .env", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "AGORA_PORT=8080\nAGORA_HOST=127.0.0.1\nAGORA_STORAGE_DIR=/tmp/relay-store\n"
    );
    // Re-import to pick up new CWD
    const { loadConfig } = await import("./config.js?port-host-dir");
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.storageDir).toBe("/tmp/relay-store");
  });

  it("should parse AGORA_STORAGE_PEERS from .env", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "AGORA_STORAGE_PEERS=key1,key2,key3\n"
    );
    const { loadConfig } = await import("./config.js?peers-env");
    const config = loadConfig(tmpDir);
    expect(config.storagePeers).toEqual(["key1", "key2", "key3"]);
  });

  it("should load peers from peers.json when present", async () => {
    const agoraHome = path.join(os.homedir(), ".agora-relay");
    const peersFile = path.join(agoraHome, "peers.json");
    const existed = fs.existsSync(peersFile);
    const backup = existed ? fs.readFileSync(peersFile) : null;

    try {
      fs.mkdirSync(agoraHome, { recursive: true });
      fs.writeFileSync(peersFile, JSON.stringify(["peerA", "peerB"]));
      const { loadConfig } = await import("./config.js?peers-json");
      const config = loadConfig();
      expect(config.storagePeers).toContain("peerA");
      expect(config.storagePeers).toContain("peerB");
    } finally {
      if (backup !== null) {
        fs.writeFileSync(peersFile, backup);
      } else if (fs.existsSync(peersFile)) {
        fs.unlinkSync(peersFile);
      }
    }
  });

  it("should expand ~/ in AGORA_STORAGE_DIR", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "AGORA_STORAGE_DIR=~/my-store\n"
    );
    const { loadConfig } = await import("./config.js?expand-home");
    const config = loadConfig();
    expect(config.storageDir).toBe(path.join(os.homedir(), "my-store"));
  });

  it("should ignore .env comment lines and blank lines", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "# This is a comment\n\nAGORA_PORT=7777\n"
    );
    const { loadConfig } = await import("./config.js?comments");
    const config = loadConfig();
    expect(config.port).toBe(7777);
  });

  it("should strip surrounding quotes from .env values", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      'AGORA_HOST="192.168.1.1"\n'
    );
    const { loadConfig } = await import('./config.js?quotes');
    const config = loadConfig();
    expect(config.host).toBe("192.168.1.1");
  });
});
