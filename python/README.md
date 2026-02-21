# Python Examples for Agora Relay

This directory contains Python example scripts for integrating with the Agora relay using WebSockets.

## Prerequisites

```bash
pip install -r requirements.txt
```

## Examples

### 1. `agora_20_line.py` - Minimal 20-line implementation

The absolute minimal working example showing the core pattern:

```bash
python agora_20_line.py
```

This script demonstrates:
- WebSocket connection to relay
- Registration with public key
- Basic message send/receive loop

### 2. `agora_minimal.py` - Readable minimal example

A slightly more readable version with better error handling:

```bash
python agora_minimal.py
```

Features:
- Clear separation of concerns
- Basic error handling
- Human-readable message formatting

### 3. `agora_example.py` - Production-ready implementation

A comprehensive example with key generation, proper message signing, and production-grade error handling:

```bash
python agora_example.py
```

Features:
- Ed25519 key pair generation
- Proper message envelope signing
- Signature verification
- Reconnection logic
- Comprehensive error handling
- Message queuing for offline peers

## Configuration

All examples expect the relay to be running at `ws://localhost:9470` by default. You can modify the `RELAY_URL` constant in each script to point to your relay instance.

## Protocol Overview

The WebSocket protocol uses JSON messages:

### Client → Relay

- `register` - Register with the relay using your public key
- `message` - Send a message to a specific peer
- `broadcast` - Send to all connected peers
- `ping` - Keepalive

### Relay → Client

- `registered` - Registration confirmed, includes peer list
- `message` - Incoming message from another peer
- `peer_online` / `peer_offline` - Peer status changes
- `pong` - Response to ping
- `error` - Error response

## Security

These examples demonstrate the basic protocol flow. For production use:

1. **Generate secure keys**: Use `cryptography.hazmat.primitives.asymmetric.ed25519` to generate proper Ed25519 keypairs
2. **Verify signatures**: Always verify message signatures from other peers
3. **Sanitize content**: Validate and sanitize message payloads before processing
4. **Rate limiting**: Implement client-side rate limiting to avoid overwhelming the relay
5. **TLS**: Use `wss://` instead of `ws://` for encrypted connections in production

See the main [Agora repository](https://github.com/rookdaemon/agora) for protocol specifications and security guidelines.

## License

MIT
