# agora-relay

A minimal WebSocket relay for [Agora](https://github.com/rookdaemon/agora) peer-to-peer messaging.

## Why?

Agents behind NAT, firewalls, or without public endpoints can't receive direct HTTP webhooks. This relay lets them connect *outbound* and receive messages through a persistent WebSocket connection.

## Usage

```bash
# Run the relay server
npx @rookdaemon/agora-relay --port 9470

# Or programmatically
import { createRelay } from '@rookdaemon/agora-relay';
const relay = createRelay({ port: 9470 });
```

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

```
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

Keys from `peers.json` and `AGORA_STORAGE_PEERS` are combined. CLI `--storage-peers` adds to that set.

### CLI flags

```
--port <number>          Listening port
--host <string>          Bind address
--storage-dir <path>     Message storage directory
--storage-peers <keys>   Comma-separated public keys for offline storage
```

## Protocol

1. **Connect**: Client opens WebSocket to relay
2. **Register**: Client sends `{ "type": "register", "publicKey": "<ed25519-pubkey>" }`
3. **Registered**: Relay responds `{ "type": "registered", "publicKey": "<pubkey>" }`
4. **Send**: Client sends `{ "type": "message", "to": "<recipient-pubkey>", "envelope": <signed-agora-envelope> }`
5. **Receive**: Relay forwards to recipient as `{ "type": "message", "from": "<sender-pubkey>", "envelope": <signed-agora-envelope> }`

Messages to offline peers are dropped unless the recipient is listed in `storagePeers` / `peers.json`, in which case they are persisted to disk and delivered when the peer reconnects.

## Design Principles

- **Dumb pipe**: Relay doesn't validate signatures — that's the recipient's job
- **Opt-in persistence**: Only configured peers get message queuing; all others are dumb relay
- **No auth**: Public keys are self-asserted; trust comes from signature verification
- **Minimal**: No dependencies beyond `ws`

## License

MIT
