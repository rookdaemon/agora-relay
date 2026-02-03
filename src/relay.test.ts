import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Relay } from "./relay.js";
import WebSocket from "ws";

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
