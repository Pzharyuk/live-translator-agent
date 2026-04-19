# live-translator-agent

macOS daemon that captures microphone audio and streams it to a
[live-translator-node](https://github.com/Pzharyuk/live-translator-node) backend via Socket.IO.

When a broadcast is active the daemon records 16 kHz / 16-bit mono PCM from your default mic,
encodes it as base64 chunks, and emits them over a persistent socket connection so the server
can transcribe and translate in real-time.

## Install via Homebrew (recommended)

```sh
brew tap Pzharyuk/tools
brew install live-translator-agent
```

Create your config file, then start the service:

```sh
mkdir -p ~/.config/live-translator-agent
cat > ~/.config/live-translator-agent/config.json << 'EOF'
{
  "serverUrl": "https://translate.onit.systems",
  "label": "My Mac"
}
EOF

brew services start live-translator-agent
```

The agent starts automatically on login and restarts if it crashes.

## Manual install

**Requirements:** Node.js ≥ 18, [sox](https://sox.sourceforge.net/)

```sh
# Install sox
brew install sox

# Clone and install deps
git clone https://github.com/Pzharyuk/live-translator-agent.git
cd live-translator-agent
npm install --production

# Create config
mkdir -p ~/.config/live-translator-agent
cat > ~/.config/live-translator-agent/config.json << 'EOF'
{
  "serverUrl": "https://translate.onit.systems",
  "label": "My Mac"
}
EOF

# Run (or use install.sh for launchd setup)
node daemon.js
```

Run `bash install.sh` to install as a launchd service instead.

## Private IP vs. Cloudflare tunnel

If your Mac is on the same network as the Kubernetes cluster you can point `serverUrl` directly at the in-cluster service IP for lower latency:

```json
{
  "serverUrl": "http://192.168.1.100:3000",
  "label": "My Mac"
}
```

| | Private IP | Cloudflare tunnel (`translate.onit.systems`) |
|---|---|---|
| Latency | Lower — no tunnel hop | Higher — traffic routes through Cloudflare edge |
| Resilience | Breaks if the service IP or node changes | Stable — survives pod reschedules and cluster changes |
| Availability | LAN only | Works from anywhere |

Use the private IP when you're always on the same network and want the lowest possible audio round-trip. Use the tunnel URL if the Mac moves between networks or if cluster IP changes are common.

## Staying alive across restarts

When installed via `brew services` or `install.sh`, the daemon runs as a macOS LaunchAgent with `KeepAlive: true`. This means:

- The agent starts automatically when you log in.
- If it crashes or is killed, launchd restarts it within a few seconds.
- It keeps reconnecting to the server on its own — no manual intervention needed after reboots or network drops.

To inspect the service state:
```sh
brew services info live-translator-agent   # Homebrew install
launchctl list | grep live-translator      # raw launchctl
```

## Config options

| Key | Default | Description |
|-----|---------|-------------|
| `serverUrl` | _(required)_ | WebSocket URL of your live-translator backend |
| `label` | `"Mac Daemon"` | Display name shown in the translator UI |
| `device` | _(system default)_ | Audio input device name (see `sox -d --list-devtypes`) |

## Dependencies

- [`socket.io-client`](https://github.com/socketio/socket.io-client) — WebSocket transport
- [`node-record-lpcm16`](https://github.com/gillesdemey/node-record-lpcm16) — mic capture via `sox`
