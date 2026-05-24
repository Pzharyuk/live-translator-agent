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
  "label": "My Mac",
  "agentPsk": "paste-the-server-PSK-here"
}
EOF

brew services start live-translator-agent
```

The agent starts automatically on login and restarts if it crashes.

### ⚠️ macOS Microphone permission (required, one-time)

Because the agent runs under `launchd`, macOS will silently kill `sox`
the first time it tries to open the microphone unless the sox binary
itself is added to the Microphone privacy list. The symptom is
`Audio stream error: macOS Microphone permission denied for sox` in
the log when a broadcast starts.

Run the bundled helper to get walked through the fix:

```sh
live-translator-agent --grant-mic
```

This opens **System Settings → Privacy & Security → Microphone** and
prints exact steps:

1. Click the `+` button below the list (unlock if prompted)
2. Press `Cmd+Shift+G` in the file picker
3. Paste `/opt/homebrew/bin/sox` → Open
4. Toggle the new **sox** entry ON
5. `brew services restart live-translator-agent`

You only need to do this once per Mac. Granting Mic permission to
Terminal does **not** cascade to launchd-spawned processes.

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
  "label": "My Mac",
  "agentPsk": "paste-the-server-PSK-here"
}
EOF

# Run (or use install.sh for launchd setup)
node daemon.js
```

Run `bash install.sh` to install as a launchd service instead. The installer prompts for the server URL, label, and pre-shared key, writes `~/.config/live-translator-agent/config.json` with mode `0600`, and loads the LaunchAgent plist.

## Private IP vs. Cloudflare tunnel

If your Mac is on the same network as the Kubernetes cluster you can point `serverUrl` directly at the in-cluster service IP for lower latency:

```json
{
  "serverUrl": "http://192.168.1.100:3000",
  "label": "My Mac",
  "agentPsk": "paste-the-server-PSK-here"
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
| `agentPsk` | `""` | Pre-shared key the server requires from agents. Get this from your server admin (`auth.agent_psk` in `application.yaml` / `AGENT_PSK` env). The `AGENT_PSK` env var overrides this field if both are set. |

## Pre-shared key (agent auth)

The backend rejects `register_audio_source` from any socket that doesn't present the configured pre-shared key, so a random client cannot connect to your server and impersonate an agent.

- **Where it lives on the server:** `auth.agent_psk` in `application.yaml`, populated from the `AGENT_PSK` environment variable.
- **Where it lives on the agent:** `agentPsk` in `~/.config/live-translator-agent/config.json`, or the `AGENT_PSK` environment variable (env wins).
- **How it travels:** in the Socket.IO handshake (`auth.agentPsk`), not as an event payload, and protected by HTTPS/WSS in transit when `serverUrl` uses `https://`.
- **If it's wrong:** the server logs `register_audio_source REJECTED ... invalid or missing PSK`, emits `agent_auth_error` to the agent, and disconnects. The agent logs the rejection and stops trying to register.
- **If the server has no PSK configured (empty string):** the server logs a warning on every registration and accepts the connection. Only use that mode while bootstrapping.

### Where the daemon looks for the key

The lookup order in `daemon.js` is:

1. `AGENT_PSK` environment variable (if set and non-empty)
2. `agentPsk` field in `~/.config/live-translator-agent/config.json`
3. otherwise empty — the daemon logs a warning and tries to register anyway (the server will reject it unless enforcement is off)

To rotate without editing JSON, set the env var inside the LaunchAgent plist (`~/Library/LaunchAgents/com.live-translator.agent.plist`):

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/you</string>
    <key>AGENT_PSK</key>
    <string>new-psk-here</string>
</dict>
```

Then reload the service:

```sh
launchctl unload ~/Library/LaunchAgents/com.live-translator.agent.plist
launchctl load   ~/Library/LaunchAgents/com.live-translator.agent.plist
# or: brew services restart live-translator-agent
```

### Rotating the PSK

1. Server admin updates `AGENT_PSK` in Vault (or the deployment env) and redeploys the backend.
2. On the Mac, edit `~/.config/live-translator-agent/config.json` (or the plist env var) with the new value.
3. `brew services restart live-translator-agent` — the daemon reconnects with the new key.

If you rotate the server-side key but forget to update agents, you'll see `agent_auth_error: invalid_psk` in the agent log and the daemon will sit idle until the keys match again.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `Server rejected registration: ...invalid PSK` in agent log | `agentPsk` (or `AGENT_PSK` env) does not match the server's `auth.agent_psk`. Fix and restart the daemon. |
| `No agentPsk in config and AGENT_PSK env unset` warning at startup | Config has no key and env is empty. Works only if the server's PSK is also empty (enforcement off). |
| Agent connects but never streams; server logs show no registration | Connection succeeded but `register_audio_source` was rejected. Look for `register_audio_source REJECTED` in the server log. |
| `macOS Microphone permission denied for sox` on broadcast start | Add `/opt/homebrew/bin/sox` to System Settings → Privacy & Security → Microphone (see `--grant-mic` helper above). |

## Dependencies

- [`socket.io-client`](https://github.com/socketio/socket.io-client) — WebSocket transport
- [`node-record-lpcm16`](https://github.com/gillesdemey/node-record-lpcm16) — mic capture via `sox`
