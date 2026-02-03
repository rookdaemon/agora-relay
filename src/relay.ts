import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";

export interface RelayOptions {
  port: number;
  host?: string;
}

interface ClientMessage {
  type: "register" | "message" | "ping";
  publicKey?: string;
  to?: string;
  envelope?: object;
}

interface RelayMessage {
  type: "registered" | "message" | "error" | "pong";
  publicKey?: string;
  from?: string;
  envelope?: object;
  code?: string;
  message?: string;
}

export class Relay extends EventEmitter {
  private options: Required<RelayOptions>;
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private clients: Map<string, WebSocket> = new Map();

  constructor(options: RelayOptions) {
    super();
    this.options = {
      port: options.port,
      host: options.host || "0.0.0.0",
    };
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
                    const oldWs = this.clients.get(message.publicKey)!;
                    oldWs.close();
                  }

                  publicKey = message.publicKey;
                  this.clients.set(publicKey, ws);

                  // Send registered confirmation
                  this.sendMessage(ws, {
                    type: "registered",
                    publicKey: publicKey,
                  });

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

                  const recipientWs = this.clients.get(message.to);
                  if (!recipientWs) {
                    this.sendError(ws, "unknown_recipient", "Recipient not connected");
                    return;
                  }

                  // Forward the message
                  this.sendMessage(recipientWs, {
                    type: "message",
                    from: publicKey,
                    envelope: message.envelope,
                  });

                  this.emit("message", publicKey, message.to, message.envelope);
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
            if (publicKey && this.clients.get(publicKey) === ws) {
              this.clients.delete(publicKey);
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
      for (const ws of this.clients.values()) {
        ws.close();
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

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendMessage(ws, {
      type: "error",
      code,
      message,
    });
  }
}
