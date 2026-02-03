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

## Protocol

1. **Connect**: Client opens WebSocket to relay
2. **Register**: Client sends `{ "type": "register", "publicKey": "<ed25519-pubkey>" }`
3. **Registered**: Relay responds `{ "type": "registered", "publicKey": "<pubkey>" }`
4. **Send**: Client sends `{ "type": "message", "to": "<recipient-pubkey>", "envelope": <signed-agora-envelope> }`
5. **Receive**: Relay forwards to recipient as `{ "type": "message", "from": "<sender-pubkey>", "envelope": <signed-agora-envelope> }`

If recipient is offline, message is dropped (no persistence).

## Design Principles

- **Dumb pipe**: Relay doesn't validate signatures — that's the recipient's job
- **No persistence**: Messages to offline peers are dropped
- **No auth**: Public keys are self-asserted; trust comes from signature verification
- **Minimal**: Single file, no dependencies beyond `ws`

## License

MIT
