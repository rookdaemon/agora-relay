import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RelayServer,
  MessageStore,
  generateKeyPair,
  createEnvelope,
} from "@rookdaemon/agora";
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
      { text: "hello bob" }
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
      {}
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

  it("should replace old connection when same pubkey registers again", async () => {
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
      JSON.stringify({ type: "register", publicKey: "duplicate-key" })
    );
    await client1RegisterPromise;

    const client1ClosePromise = new Promise<void>((resolve) => {
      client1.on("close", () => resolve());
    });

    const client2RegisterPromise = new Promise<void>((resolve) => {
      client2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered") resolve();
      });
    });
    client2.send(
      JSON.stringify({ type: "register", publicKey: "duplicate-key" })
    );
    await client2RegisterPromise;

    await client1ClosePromise;

    client2.close();
  });

  it("should emit agent-disconnected event when client disconnects", async () => {
    const disconnectionPromise = new Promise<string>((resolve) => {
      relay.on("agent-disconnected", (publicKey) => {
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
});
