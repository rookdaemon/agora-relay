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
  sessionId?: string;
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
  /** publicKey -> (sessionId -> ClientInfo) */
  private sessions: Map<string, Map<string, ClientInfo>> = new Map();
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
          let sessionId: string | null = null;

          ws.on("message", (data: Buffer) => {
            try {
              const message: ClientMessage = JSON.parse(data.toString());

              switch (message.type) {
                case "register":
                  if (!message.publicKey) {
                    this.sendError(ws, "invalid_message", "Missing publicKey");
                    return;
                  }

                  publicKey = message.publicKey;
                  sessionId = crypto.randomUUID();
                  // Never treat the short key (id) as a display name; leave name undefined
                  const rawName = message.name;
                  const clientName =
                    rawName && !/^\.\.\.[a-f0-9]{8}$/i.test(rawName.trim()) ? rawName : undefined;

                  // Add this session to the sessions map (create inner map if needed)
                  if (!this.sessions.has(publicKey)) {
                    this.sessions.set(publicKey, new Map());
                  }
                  this.sessions.get(publicKey)!.set(sessionId, { ws, name: clientName });
                  const isFirstSession = this.sessions.get(publicKey)!.size === 1;

                  // Send registered confirmation with session ID and list of online peers (including names)
                  const otherPeers = Array.from(this.sessions.entries())
                    .filter(([k]) => k !== publicKey)
                    .map(([k, sessionMap]) => {
                      const info = sessionMap.values().next().value as ClientInfo;
                      return { publicKey: k, name: info?.name };
                    });
                  // Storage-enabled peers are always considered connected (store-and-forward)
                  for (const storagePeer of this.options.storagePeers) {
                    if (storagePeer !== publicKey && !this.sessions.has(storagePeer)) {
                      otherPeers.push({ publicKey: storagePeer, name: undefined });
                    }
                  }
                  this.sendMessage(ws, {
                    type: "registered",
                    publicKey: publicKey,
                    sessionId: sessionId,
                    peers: otherPeers,
                  });

                  // Broadcast peer_online only when this is the first session for this peer
                  if (isFirstSession) {
                    this.broadcast({ type: "peer_online", publicKey, name: clientName }, publicKey);
                  }

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

                  const recipientSessions = this.sessions.get(message.to);
                  if (!recipientSessions || recipientSessions.size === 0) {
                    // If the recipient is a storage-enabled peer, queue the message
                    if (this.store && this.options.storagePeers.includes(message.to)) {
                      const senderInfoOffline = this.getClientInfo(publicKey);
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

                  // Forward the message to ALL sessions of the recipient
                  const senderInfo = this.getClientInfo(publicKey);
                  for (const recipientSession of recipientSessions.values()) {
                    this.sendMessage(recipientSession.ws, {
                      type: "message",
                      from: publicKey,
                      name: senderInfo?.name,
                      envelope: message.envelope,
                    });
                  }

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

                  // Send to all other clients (all sessions of all other peers)
                  const broadcasterInfo = this.getClientInfo(publicKey);
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
            if (publicKey && sessionId) {
              const peerSessions = this.sessions.get(publicKey);
              if (peerSessions) {
                const clientInfo = peerSessions.get(sessionId);
                if (clientInfo && clientInfo.ws === ws) {
                  peerSessions.delete(sessionId);
                  if (peerSessions.size === 0) {
                    this.sessions.delete(publicKey);
                    // Storage-enabled peers are always considered connected; skip peer_offline for them
                    if (!this.options.storagePeers.includes(publicKey)) {
                      this.broadcast({ type: "peer_offline", publicKey, name: clientInfo.name });
                    }
                  }
                  this.emit("disconnection", publicKey);
                }
              }
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
      for (const sessionMap of this.sessions.values()) {
        for (const client of sessionMap.values()) {
          client.ws.close();
        }
      }
      this.sessions.clear();

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

  /** Returns the ClientInfo for any active session of the given peer, or undefined if none. */
  private getClientInfo(publicKey: string): ClientInfo | undefined {
    const sessionMap = this.sessions.get(publicKey);
    return sessionMap?.values().next().value as ClientInfo | undefined;
  }

  private broadcast(message: RelayMessage, excludeKey?: string): void {
    for (const [key, sessionMap] of this.sessions.entries()) {
      if (key !== excludeKey) {
        for (const client of sessionMap.values()) {
          this.sendMessage(client.ws, message);
        }
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
