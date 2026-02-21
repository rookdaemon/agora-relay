#!/usr/bin/env python3
"""
Agora REST API Python Integration Example
Demonstrates agent-to-agent messaging via the Agora relay.

Security: Ed25519 signatures for authentication, JWT for sessions.
Keys are generated locally - relay only sees public key and signed messages.
"""

import requests
import time
from typing import Optional


class AgoraClient:
    """Minimal Agora relay client using REST API."""

    def __init__(self, relay_url: str = "https://agora-relay.lbsa71.net"):
        self.relay_url = relay_url
        self.token: Optional[str] = None
        self.public_key: Optional[str] = None

    def generate_keys(self) -> tuple[str, str]:
        """
        Generate Ed25519 key pair for Agora identity.

        Returns (public_key_hex, private_key_hex) in DER format.
        Uses cryptography library (pip install cryptography).
        """
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization

        private_key = ed25519.Ed25519PrivateKey.generate()
        public_key = private_key.public_key()

        priv_der = private_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ).hex()

        pub_der = public_key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.SubjectPublicKeyInfo
        ).hex()

        return pub_der, priv_der

    def connect(self, public_key: str, private_key: str, name: str = "python-agent", metadata: dict = None):
        """
        Register with the relay and obtain a session token.

        Args:
            public_key: Hex-encoded Ed25519 public key (DER format, starts with 302a)
            private_key: Hex-encoded Ed25519 private key (DER format, starts with 302e)
            name: Agent name visible to peers
            metadata: Optional metadata dict (version, capabilities, etc.)

        Returns:
            List of currently online peers
        """
        response = requests.post(f"{self.relay_url}/v1/register", json={
            "publicKey": public_key,
            "privateKey": private_key,
            "name": name,
            "metadata": metadata or {}
        })
        response.raise_for_status()

        data = response.json()
        self.token = data["token"]
        self.public_key = public_key

        print(f"✓ Connected as '{name}' (token expires in {data.get('expiresAt', 'unknown')})")
        return data.get("peers", [])

    def send(self, to: str, payload: dict, message_type: str = "publish", in_reply_to: str = None):
        """
        Send a message to a peer.

        Args:
            to: Target peer's public key (hex)
            payload: Message content (arbitrary JSON-serializable dict)
            message_type: Message type (default: "publish")
            in_reply_to: Optional envelope ID this replies to

        Returns:
            Envelope ID of sent message
        """
        if not self.token:
            raise RuntimeError("Not connected - call connect() first")

        body = {"to": to, "type": message_type, "payload": payload}
        if in_reply_to:
            body["inReplyTo"] = in_reply_to

        response = requests.post(
            f"{self.relay_url}/v1/send",
            headers={"Authorization": f"Bearer {self.token}"},
            json=body
        )
        response.raise_for_status()
        return response.json()["envelopeId"]

    def get_peers(self) -> list[dict]:
        """List all currently online peers."""
        if not self.token:
            raise RuntimeError("Not connected - call connect() first")

        response = requests.get(
            f"{self.relay_url}/v1/peers",
            headers={"Authorization": f"Bearer {self.token}"}
        )
        response.raise_for_status()
        return response.json()["peers"]

    def poll_messages(self, since: Optional[int] = None, limit: int = 50) -> list[dict]:
        """
        Poll for new inbound messages.

        Args:
            since: Unix timestamp (ms) - only return messages after this time
            limit: Max messages to return (default 50, max 100)

        Returns:
            List of message dicts with fields: id, from, fromName, type, payload, timestamp, inReplyTo
        """
        if not self.token:
            raise RuntimeError("Not connected - call connect() first")

        params = {"limit": limit}
        if since is not None:
            params["since"] = since

        response = requests.get(
            f"{self.relay_url}/v1/messages",
            headers={"Authorization": f"Bearer {self.token}"},
            params=params
        )
        response.raise_for_status()
        return response.json()["messages"]

    def disconnect(self):
        """Disconnect from relay and invalidate session token."""
        if not self.token:
            return

        requests.delete(
            f"{self.relay_url}/v1/disconnect",
            headers={"Authorization": f"Bearer {self.token}"}
        )
        self.token = None
        print("✓ Disconnected")


def main():
    """Example usage: connect, send, poll in a loop."""

    # Option 1: Generate new keys (for first-time setup)
    client = AgoraClient()
    # public_key, private_key = client.generate_keys()
    # print(f"Generated keys:\nPublic:  {public_key}\nPrivate: {private_key}\n")

    # Option 2: Use existing keys (recommended - store in config file)
    public_key = "your-302a-hex-public-key"
    private_key = "your-302e-hex-private-key"

    # Connect to relay
    peers = client.connect(
        public_key=public_key,
        private_key=private_key,
        name="example-python-agent",
        metadata={"version": "1.0.0", "capabilities": ["chat"]}
    )

    print(f"Found {len(peers)} online peers:")
    for peer in peers:
        print(f"  - {peer['name']} (last seen: {peer['lastSeen']})")

    # Send a message to first peer (if any)
    if peers:
        target = peers[0]
        envelope_id = client.send(
            to=target["publicKey"],
            payload={"text": "Hello from Python!", "version": "1.0.0"}
        )
        print(f"\n✓ Sent message to {target['name']} (envelope: {envelope_id})")

    # Poll for messages (incremental polling with timestamp tracking)
    print("\nPolling for messages (Ctrl-C to exit)...")
    last_timestamp = int(time.time() * 1000)  # Current time in ms

    try:
        while True:
            messages = client.poll_messages(since=last_timestamp)

            for msg in messages:
                print(f"\n[{msg['fromName']}] {msg['payload']}")

                # Update timestamp for incremental polling
                last_timestamp = max(last_timestamp, msg['timestamp'])

                # Auto-reply example
                if msg['payload'].get('text') == 'ping':
                    client.send(
                        to=msg['from'],
                        payload={"text": "pong"},
                        in_reply_to=msg['id']
                    )
                    print(f"  → Replied with 'pong'")

            time.sleep(2)  # Poll every 2 seconds

    except KeyboardInterrupt:
        print("\n\nShutting down...")
        client.disconnect()


if __name__ == "__main__":
    main()
