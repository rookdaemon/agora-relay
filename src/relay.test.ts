import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Relay } from "./relay.js";
import { MessageStore } from "./store.js";
import WebSocket from "ws";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("Relay", () => {
  let relay: Relay;
  const testPort = 9471;

  beforeEach(async () => {
    relay = new Relay({ port: testPort });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  it("should start and stop successfully", async () => {
    // Server already started in beforeEach
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
      
      setTimeout(() => reject(new Error("Timeout")), 1000);
    });
  });

  it("should emit connection event on registration", async () => {
    const connectionPromise = new Promise<string>((resolve) => {
      relay.on("connection", (publicKey) => {
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

  it("should route messages between two clients", async () => {
    const client1 = new WebSocket(`ws://localhost:${testPort}`);
    const client2 = new WebSocket(`ws://localhost:${testPort}`);

    // Wait for both clients to connect
    await Promise.all([
      new Promise<void>((resolve) => client1.on("open", resolve)),
      new Promise<void>((resolve) => client2.on("open", resolve)),
    ]);

    // Register client1
    const client1RegisterPromise = new Promise<void>((resolve) => {
      client1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    client1.send(JSON.stringify({ type: "register", publicKey: "alice" }));
    await client1RegisterPromise;

    // Register client2
    const client2RegisterPromise = new Promise<void>((resolve) => {
      let registered = false;
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered" && !registered) {
          registered = true;
          resolve();
        }
      });
    });
    client2.send(JSON.stringify({ type: "register", publicKey: "bob" }));
    await client2RegisterPromise;

    // Send message from client1 to client2
    const messagePromise = new Promise<any>((resolve) => {
      let registered = false;
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "message") {
          resolve(msg);
        } else if (msg.type === "registered" && !registered) {
          registered = true;
        }
      });
    });

    const envelope = { data: "hello bob" };
    client1.send(JSON.stringify({ type: "message", to: "bob", envelope }));

    const receivedMsg = await messagePromise;
    expect(receivedMsg.type).toBe("message");
    expect(receivedMsg.from).toBe("alice");
    expect(receivedMsg.envelope).toEqual(envelope);

    client1.close();
    client2.close();
  });

  it("should return error when sending before registration", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const errorPromise = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          resolve(msg);
        }
      });
    });

    ws.send(JSON.stringify({ type: "message", to: "someone", envelope: {} }));

    const error = await errorPromise;
    expect(error.type).toBe("error");
    expect(error.code).toBe("not_registered");

    ws.close();
  });

  it("should return error for unknown recipient", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Register first
    const registerPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: "register", publicKey: "sender" }));
    await registerPromise;

    // Try to send to non-existent recipient
    const errorPromise = new Promise<any>((resolve) => {
      let registered = false;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          resolve(msg);
        } else if (msg.type === "registered" && !registered) {
          registered = true;
        }
      });
    });

    ws.send(JSON.stringify({ type: "message", to: "unknown", envelope: {} }));

    const error = await errorPromise;
    expect(error.type).toBe("error");
    expect(error.code).toBe("unknown_recipient");

    ws.close();
  });

  it("should replace old connection when same pubkey registers again", async () => {
    const client1 = new WebSocket(`ws://localhost:${testPort}`);
    const client2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => client1.on("open", resolve)),
      new Promise<void>((resolve) => client2.on("open", resolve)),
    ]);

    // Register client1 with pubkey "duplicate"
    const client1RegisterPromise = new Promise<void>((resolve) => {
      client1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    client1.send(JSON.stringify({ type: "register", publicKey: "duplicate" }));
    await client1RegisterPromise;

    // Client1 should be closed when client2 registers with same key
    const client1ClosePromise = new Promise<void>((resolve) => {
      client1.on("close", () => resolve());
    });

    // Register client2 with same pubkey "duplicate"
    const client2RegisterPromise = new Promise<void>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    client2.send(JSON.stringify({ type: "register", publicKey: "duplicate" }));
    await client2RegisterPromise;

    // Client1 should have been closed
    await client1ClosePromise;

    client2.close();
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
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    ws.send(JSON.stringify({ type: "register", publicKey: "disconnect-test" }));
    await registerPromise;

    ws.close();

    const disconnectedKey = await disconnectionPromise;
    expect(disconnectedKey).toBe("disconnect-test");
  });

  it("should emit message event when routing messages", async () => {
    const messageEventPromise = new Promise<{ from: string; to: string; envelope: any }>((resolve) => {
      relay.on("message", (from, to, envelope) => {
        resolve({ from, to, envelope });
      });
    });

    const client1 = new WebSocket(`ws://localhost:${testPort}`);
    const client2 = new WebSocket(`ws://localhost:${testPort}`);

    await Promise.all([
      new Promise<void>((resolve) => client1.on("open", resolve)),
      new Promise<void>((resolve) => client2.on("open", resolve)),
    ]);

    // Register both clients
    const client1RegisterPromise = new Promise<void>((resolve) => {
      client1.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    client1.send(JSON.stringify({ type: "register", publicKey: "sender" }));
    await client1RegisterPromise;

    const client2RegisterPromise = new Promise<void>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") {
          resolve();
        }
      });
    });
    client2.send(JSON.stringify({ type: "register", publicKey: "receiver" }));
    await client2RegisterPromise;

    // Send message
    const envelope = { test: "data" };
    client1.send(JSON.stringify({ type: "message", to: "receiver", envelope }));

    const event = await messageEventPromise;
    expect(event.from).toBe("sender");
    expect(event.to).toBe("receiver");
    expect(event.envelope).toEqual(envelope);

    client1.close();
    client2.close();
  });

  it("should respond to ping with pong", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const pongPromise = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") {
          resolve();
        }
      });
    });

    ws.send(JSON.stringify({ type: "ping" }));

    await pongPromise;
    ws.close();
  });

  it("should return error for invalid message format", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}`);

    await new Promise<void>((resolve) => ws.on("open", resolve));

    const errorPromise = new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          resolve(msg);
        }
      });
    });

    ws.send("not valid json");

    const error = await errorPromise;
    expect(error.type).toBe("error");
    expect(error.code).toBe("invalid_message");

    ws.close();
  });
});

describe("MessageStore", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-relay-test-"));
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

describe("Relay with file-backed storage", () => {
  let relay: Relay;
  let storageDir: string;
  const testPort = 9472;

  beforeEach(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-relay-test-"));
    relay = new Relay({ port: testPort, storagePeers: ["alice"], storageDir });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("should queue message for storage-enabled offline peer without error", async () => {
    const sender = new WebSocket(`ws://localhost:${testPort}`);
    await new Promise<void>((resolve) => sender.on("open", resolve));

    const registerPromise = new Promise<void>((resolve) => {
      sender.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    sender.send(JSON.stringify({ type: "register", publicKey: "bob" }));
    await registerPromise;

    // Collect all messages from sender (should not contain an error)
    const received: any[] = [];
    sender.on("message", (data) => received.push(JSON.parse(data.toString())));

    const envelope = { text: "offline message" };
    sender.send(JSON.stringify({ type: "message", to: "alice", envelope }));

    // Brief pause to allow any error response
    await new Promise((r) => setTimeout(r, 100));

    const errors = received.filter((m) => m.type === "error");
    expect(errors).toHaveLength(0);

    sender.close();
  });

  it("should deliver queued messages when storage-enabled peer reconnects", async () => {
    const sender = new WebSocket(`ws://localhost:${testPort}`);
    await new Promise<void>((resolve) => sender.on("open", resolve));

    const senderReady = new Promise<void>((resolve) => {
      sender.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    sender.send(JSON.stringify({ type: "register", publicKey: "bob" }));
    await senderReady;

    // alice is offline — send a message to her
    const envelope = { text: "stored for alice" };
    sender.send(JSON.stringify({ type: "message", to: "alice", envelope }));
    await new Promise((r) => setTimeout(r, 100));

    // Now alice comes online
    const alice = new WebSocket(`ws://localhost:${testPort}`);
    await new Promise<void>((resolve) => alice.on("open", resolve));

    const aliceMessages: any[] = [];
    const aliceReady = new Promise<void>((resolve) => {
      alice.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        aliceMessages.push(msg);
        if (msg.type === "registered") resolve();
      });
    });
    alice.send(JSON.stringify({ type: "register", publicKey: "alice" }));
    await aliceReady;

    // Allow time for queued messages to be delivered
    await new Promise((r) => setTimeout(r, 100));

    const delivered = aliceMessages.filter((m) => m.type === "message");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].from).toBe("bob");
    expect(delivered[0].envelope).toEqual(envelope);

    sender.close();
    alice.close();
  });

  it("should still return error for non-storage-enabled offline peers", async () => {
    const sender = new WebSocket(`ws://localhost:${testPort}`);
    await new Promise<void>((resolve) => sender.on("open", resolve));

    const registerPromise = new Promise<void>((resolve) => {
      sender.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "registered") resolve();
      });
    });
    sender.send(JSON.stringify({ type: "register", publicKey: "bob" }));
    await registerPromise;

    const errorPromise = new Promise<any>((resolve) => {
      sender.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") resolve(msg);
      });
    });

    // "charlie" is not in storagePeers
    sender.send(JSON.stringify({ type: "message", to: "charlie", envelope: { x: 1 } }));

    const error = await errorPromise;
    expect(error.code).toBe("unknown_recipient");

    sender.close();
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
    const config = loadConfig();
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
    const config = loadConfig();
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
