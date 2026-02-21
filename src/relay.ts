import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import { MessageStore } from "./store.js";

export interface RelayOptions {
  port: number;
  host?: string;
  /** Public keys whose messages should be stored when they are offline */
  storagePeers?: string[];
  /** Directory used to persist messages for offline peers */
  storageDir?: string;
}

interface ClientMessage {
  type: "register" | "message" | "broadcast" | "ping";
  publicKey?: string;
  name?: string;  // Optional display name (hint only, not authoritative)
  to?: string;
  envelope?: object;
}

interface RelayMessage {
  type: "registered" | "message" | "error" | "pong" | "peer_online" | "peer_offline" | "peers";
  publicKey?: string;
  name?: string;  // Optional display name
  from?: string;
  envelope?: object;
  code?: string;
  message?: string;
  peers?: Array<{publicKey: string; name?: string}>;
}

interface ClientInfo {
  ws: WebSocket;
  name?: string;
}

export class Relay extends EventEmitter {
  private options: Required<RelayOptions>;
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private clients: Map<string, ClientInfo> = new Map();
  private store: MessageStore | null = null;

  constructor(options: RelayOptions) {
    super();
    this.options = {
      port: options.port,
      host: options.host || "0.0.0.0",
      storagePeers: options.storagePeers || [],
      storageDir: options.storageDir || "",
    };
    if (this.options.storagePeers.length > 0 && this.options.storageDir) {
      this.store = new MessageStore(this.options.storageDir);
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server
        this.server = http.createServer();
        
        // Create WebSocket server
        this.wss = new WebSocketServer({ server: this.server });

        this.wss.on("connection", (ws: WebSocket) => {
          let publicKey: string | null = null;

          ws.on("message", (data: Buffer) => {
            try {
              const message: ClientMessage = JSON.parse(data.toString());

              switch (message.type) {
                case "register":
                  if (!message.publicKey) {
                    this.sendError(ws, "invalid_message", "Missing publicKey");
                    return;
                  }

                  // If this pubkey was already connected, close the old connection
                  if (this.clients.has(message.publicKey)) {
                    const oldClient = this.clients.get(message.publicKey)!;
                    oldClient.ws.close();
                  }

                  publicKey = message.publicKey;
                  // Never treat the short key (id) as a display name; leave name undefined
                  const rawName = message.name;
                  const clientName =
                    rawName && !/^\.\.\.[a-f0-9]{8}$/i.test(rawName.trim()) ? rawName : undefined;
                  this.clients.set(publicKey, { ws, name: clientName });

                  // Send registered confirmation with list of online peers (including names)
                  const otherPeers = Array.from(this.clients.entries())
                    .filter(([k]) => k !== publicKey)
                    .map(([k, info]) => ({ publicKey: k, name: info.name }));
                  this.sendMessage(ws, {
                    type: "registered",
                    publicKey: publicKey,
                    peers: otherPeers,
                  });

                  // Broadcast peer_online to all other clients (include name)
                  this.broadcast({ type: "peer_online", publicKey, name: clientName }, publicKey);

                  // Deliver any stored messages for this peer
                  if (this.store && this.options.storagePeers.includes(publicKey)) {
                    const queued = this.store.load(publicKey);
                    if (queued.length > 0) {
                      for (const msg of queued) {
                        this.sendMessage(ws, {
                          type: "message",
                          from: msg.from,
                          name: msg.name,
                          envelope: msg.envelope,
                        });
                      }
                      this.store.clear(publicKey);
                    }
                  }

                  this.emit("connection", publicKey);
                  break;

                case "message":
                  if (!publicKey) {
                    this.sendError(ws, "not_registered", "Client not registered");
                    return;
                  }

                  if (!message.to || !message.envelope) {
                    this.sendError(ws, "invalid_message", "Missing to or envelope");
                    return;
                  }

                  const recipient = this.clients.get(message.to);
                  if (!recipient) {
                    // If the recipient is a storage-enabled peer, queue the message
                    if (this.store && this.options.storagePeers.includes(message.to)) {
                      const senderInfoOffline = this.clients.get(publicKey);
                      this.store.save(message.to, {
                        from: publicKey,
                        name: senderInfoOffline?.name,
                        envelope: message.envelope,
                      });
                      this.emit("message", publicKey, message.to, message.envelope);
                    } else {
                      this.sendError(ws, "unknown_recipient", "Recipient not connected");
                    }
                    return;
                  }

                  // Forward the message (include sender's name if available)
                  const senderInfo = this.clients.get(publicKey);
                  this.sendMessage(recipient.ws, {
                    type: "message",
                    from: publicKey,
                    name: senderInfo?.name,
                    envelope: message.envelope,
                  });

                  this.emit("message", publicKey, message.to, message.envelope);
                  break;

                case "broadcast":
                  if (!publicKey) {
                    this.sendError(ws, "not_registered", "Client not registered");
                    return;
                  }

                  if (!message.envelope) {
                    this.sendError(ws, "invalid_message", "Missing envelope");
                    return;
                  }

                  // Send to all other clients
                  const broadcasterInfo = this.clients.get(publicKey);
                  this.broadcast({
                    type: "message",
                    from: publicKey,
                    name: broadcasterInfo?.name,
                    envelope: message.envelope,
                  }, publicKey);

                  this.emit("broadcast", publicKey, message.envelope);
                  break;

                case "ping":
                  this.sendMessage(ws, { type: "pong" });
                  break;

                default:
                  this.sendError(ws, "invalid_message", "Unknown message type");
              }
            } catch {
              this.sendError(ws, "invalid_message", "Failed to parse message");
            }
          });

          ws.on("close", () => {
            const clientInfo = publicKey ? this.clients.get(publicKey) : null;
            if (publicKey && clientInfo && clientInfo.ws === ws) {
              this.clients.delete(publicKey);
              // Broadcast peer_offline to all remaining clients (include name)
              this.broadcast({ type: "peer_offline", publicKey, name: clientInfo.name });
              this.emit("disconnection", publicKey);
            }
          });

          ws.on("error", () => {
            // Ignore errors, they'll trigger close event
          });
        });

        // Start the server
        this.server.listen(this.options.port, this.options.host, () => {
          resolve();
        });

        this.server.on("error", reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close all client connections
      for (const client of this.clients.values()) {
        client.ws.close();
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          // Close HTTP server
          if (this.server) {
            this.server.close((err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  private sendMessage(ws: WebSocket, message: RelayMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcast(message: RelayMessage, excludeKey?: string): void {
    for (const [key, client] of this.clients.entries()) {
      if (key !== excludeKey) {
        this.sendMessage(client.ws, message);
      }
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendMessage(ws, {
      type: "error",
      code,
      message,
    });
  }
}
