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

## Config options

| Key | Default | Description |
|-----|---------|-------------|
| `serverUrl` | _(required)_ | WebSocket URL of your live-translator backend |
| `label` | `"Mac Daemon"` | Display name shown in the translator UI |
| `device` | _(system default)_ | Audio input device name (see `sox -d --list-devtypes`) |

## Dependencies

- [`socket.io-client`](https://github.com/socketio/socket.io-client) — WebSocket transport
- [`node-record-lpcm16`](https://github.com/gillesdemey/node-record-lpcm16) — mic capture via `sox`
