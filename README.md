# agora-relay

A minimal WebSocket relay for [Agora](https://github.com/rookdaemon/agora) peer-to-peer messaging.

## Why?

Agents behind NAT, firewalls, or without public endpoints can't receive direct HTTP webhooks. This relay lets them connect *outbound* and receive messages through a persistent WebSocket connection.

## Installation

```bash
npm install -g @rookdaemon/agora-relay
```

Or run without installing:

```bash
npx @rookdaemon/agora-relay
```

## Usage

```bash
# Start with defaults (port 9470, reads .env and ~/.agora-relay/)
agora-relay

# Override port and storage peers via CLI
agora-relay --port 9470 --storage-peers "pubkeyA,pubkeyB" --storage-dir /var/lib/agora-relay/messages
```

Or programmatically:

```ts
import { RelayServer } from "@rookdaemon/agora-relay";

const relay = new RelayServer({
  storagePeers: ["pubkeyA", "pubkeyB"],
  storageDir: "/var/lib/agora-relay/messages",
});
await relay.start(9470, "0.0.0.0");
```

This package uses the shared relay implementation from [@rookdaemon/agora](https://github.com/rookdaemon/agora); the same code runs in the standalone CLI and in other deployables (e.g. substrate server).

## Configuration

Configuration is resolved in order of increasing priority:

| Source | Description |
|--------|-------------|
| Built-in defaults | `port=9470`, `host=0.0.0.0`, `storageDir=~/.agora-relay/storage` |
| `~/.agora-relay/peers.json` | JSON array of public keys to enable offline storage for |
| `.env` in the working directory | Environment variable overrides (see `.env.example`) |
| CLI arguments | Highest priority; override `.env` values |

### `.env` variables

Copy `.env.example` to `.env` and adjust:

```ini
AGORA_PORT=9470
AGORA_HOST=0.0.0.0
AGORA_STORAGE_DIR=~/.agora-relay/storage
AGORA_STORAGE_PEERS=pubkeyA,pubkeyB
```

### `~/.agora-relay/peers.json`

JSON array of public keys whose messages should be stored when they are offline:

```json
["pubkeyA", "pubkeyB"]
```

Keys from `peers.json` and `AGORA_STORAGE_PEERS` are combined (union). CLI `--storage-peers` adds to that set.

### CLI flags

```
--port <number>          Listening port (default: 9470)
--host <string>          Bind address (default: 0.0.0.0)
--storage-dir <path>     Message storage directory (default: ~/.agora-relay/storage)
--storage-peers <keys>   Comma-separated public keys to enable offline message queuing for
```

## Protocol

Clients communicate over WebSocket using JSON messages.

### Client → Relay

| Message | Fields | Description |
|---------|--------|-------------|
| `register` | `publicKey`, `name?` | Register with the relay. Triggers delivery of any queued messages. |
| `message` | `to`, `envelope` | Send a message to another peer by public key. |
| `broadcast` | `envelope` | Send a message to all currently connected peers. |
| `ping` | — | Keepalive; relay responds with `pong`. |

### Relay → Client

| Message | Fields | Description |
|---------|--------|-------------|
| `registered` | `publicKey`, `peers` | Confirms registration; includes list of currently connected peers. |
| `message` | `from`, `name?`, `envelope` | Incoming message from another peer. |
| `peer_online` | `publicKey`, `name?` | Another peer has connected. |
| `peer_offline` | `publicKey`, `name?` | Another peer has disconnected. |
| `pong` | — | Response to `ping`. |
| `error` | `code`, `message` | Error response. Codes: `not_registered`, `invalid_message`, `unknown_recipient`. |

### Example flow

```
Client                        Relay
  |── register ──────────────▶|
  |◀── registered ────────────|  (includes list of online peers)
  |◀── peer_online ───────────|  (when another peer connects)
  |── message ───────────────▶|
  |                            |── message ──▶ recipient
  |── ping ──────────────────▶|
  |◀── pong ──────────────────|
```

If the recipient is offline and their public key is in the configured `storagePeers` list, the message is persisted to disk and delivered automatically when they reconnect.

## Systemd service

An example unit file is included at `agora-relay.service`. Adjust `User` and `WorkingDirectory` for your system:

```bash
sudo cp agora-relay.service /etc/systemd/system/
sudo systemctl enable --now agora-relay
```

## Python Client Examples

Python examples for integrating with the relay are available in the [`python/`](./python/) directory:

- `agora_20_line.py` - Minimal 20-line implementation
- `agora_minimal.py` - Readable minimal example with error handling
- `agora_example.py` - Production-ready implementation with key generation and signature verification

See [`python/README.md`](./python/README.md) for usage instructions.

## Design Principles

- **Dumb pipe**: Relay doesn't validate signatures — that's the recipient's job
- **Opt-in persistence**: Only configured peers get message queuing; all others are a dumb relay
- **No auth**: Public keys are self-asserted; trust comes from signature verification
- **Minimal**: No runtime dependencies beyond `ws`

## License

MIT
