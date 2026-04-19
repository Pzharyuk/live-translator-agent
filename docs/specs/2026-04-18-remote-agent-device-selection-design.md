# Remote agent audio device selection

Date: 2026-04-18
Status: approved, pending implementation plan
Repositories touched: `live-translator-agent`, `live-translator-node`, `Pzharyuk/homebrew-tools`

## Problem

The browserless agent (`live-translator-agent`, installed via `brew`) registers itself as a single remote audio source identified by a hardcoded `deviceId: 'mac-daemon-mic'` and captures from the macOS default input device. Admins have no way to see which microphones exist on the agent's Mac or pick a non-default one (USB interface, external mic, headset) from the admin portal. The admin panel's Connected Agent Sources list shows a static `label + "ready"` row with no selector.

## Goal

From the admin portal, an admin can:

1. See each connected agent's available input devices.
2. Select a specific device to broadcast from.
3. Have the selection persist across agent restarts (reboot, `brew upgrade`, service restart).
4. Switch devices mid-broadcast; the change takes effect immediately.

## Non-goals

- Automatic hotplug detection (admin triggers a manual refresh instead).
- Per-workspace scoping — all sources remain in `DEFAULT_WORKSPACE_ID`; multi-tenant comes later.
- Any end-user-facing UI change (receiver/translator pages).
- Linux/Windows agent support — macOS only for v1.

## Architecture

```
┌───────────┐  register_audio_source       ┌────────────┐  remote_audio_sources   ┌──────────┐
│  Agent    │ ─(agentId, devices[],     ─▶ │  Backend   │ ─(adds devices +        │  Admin   │
│ (daemon)  │   selectedDevice)            │            │   selectedDevice)──────▶│   UI     │
│           │ ◀───select_device────────    │            │ ◀──select_agent_device  │          │
│           │ ◀───refresh_devices──────    │            │ ◀──refresh_devices      │          │
└───────────┘                              └────────────┘                         └──────────┘
                                                  │
                                           Redis: setting:agent_device:<agentId> -> <deviceId>
```

All coordination happens over the existing Socket.IO connection. No new HTTP endpoints.

## Component changes

### Agent (`live-translator-agent/daemon.js`)

**Stable identity.** On first run, generate a v4 UUID and write to `~/.config/live-translator-agent/state.json` alongside the existing `config.json`. On subsequent runs, read and reuse it. This `agentId` is the Redis persistence key.

**Device enumeration.** Call `system_profiler SPAudioDataType -json` at startup and parse:

- Iterate `SPAudioDataType[*]._items[*]` looking for entries with `coreaudio_device_input > 0`.
- Map each to `{ id: <coreaudio_device_id>, name: <_name> }`.
- Empty list is valid — register with `devices: []`.

**Registration.** Extend the `register_audio_source` emit payload:

```js
socket.emit('register_audio_source', {
  agentId,
  label,                 // existing
  deviceId,              // existing; preserved for backward compat
  devices,               // new: [{ id, name }]
  selectedDevice,        // new: id or null
});
```

On startup, `selectedDevice` is `null`; the server replies with a `select_device { id }` event if a persisted choice exists.

**Live switch.** Listen for `select_device { id }`:

- If the id is not in the current `devices[]`, emit `audio_stream_error { deviceId: id, message: 'device not available' }` and ignore.
- Else update `selectedDevice`; if currently streaming, call `stopStreaming()` then `startStreaming()` reusing the existing audio pipeline but pass `{ device: 'coreaudio ' + deviceName }` to `recorder.record(...)`. Accept the brief audio gap as the intended behavior.
- If not currently streaming, just remember the selection; the next `broadcast_status { source: 'remote', active: true }` will start on the new device.

**Refresh.** Listen for `refresh_devices`: re-run `system_profiler`, emit a new `register_audio_source` with the updated `devices[]` (server treats this as an in-place update keyed by `socket.id`).

**Hotplug.** Deferred — no automatic polling or USB-event listener.

### Backend (`live-translator-node`)

#### `broadcast-manager.service.ts`

Extend the in-memory `RemoteSource` record:

```ts
interface RemoteSource {
  socketId: string;
  agentId: string;
  label: string;
  deviceId: string;                                    // legacy field, retained
  devices: { id: string; name: string }[];             // new
  selectedDevice: string | null;                       // new
}
```

`addRemoteSource`, `removeRemoteSource`, `getRemoteSources` signatures unchanged; internals accommodate the wider type.

#### `translation.socket.ts`

1. `register_audio_source` handler ([current location: `backend/src/sockets/translation.socket.ts:1031`](backend/src/sockets/translation.socket.ts#L1031)):
   - Accept the expanded payload.
   - Look up `setting:agent_device:<agentId>` in Redis.
   - If a persisted device id exists **and** it appears in the agent's reported `devices[]`, adopt it as `selectedDevice`; otherwise keep whatever the agent sent (null on fresh start).
   - Persist the full record via `broadcastManager.addRemoteSource`.
   - Emit `remote_audio_sources` to all sockets (existing broadcast).
   - If the adopted `selectedDevice` differs from the agent's reported value, emit `select_device { id }` to the agent's socket so the agent aligns.

2. New handler `select_agent_device { socketId, deviceId }` (admin → server):
   - Authorization: match the existing pattern for admin-panel socket events in this file — no extra JWT validation at the socket layer beyond what's already in place. The admin UI is the only surface that emits this event; adding socket-level auth is a separate concern tracked outside this spec.
   - Look up the target source by `socketId`; if missing, emit `device_select_error { socketId, message: 'source not connected' }` to the caller.
   - Validate `deviceId` is in that source's `devices[]`; if not, emit `device_select_error { socketId, message: 'device not available' }`.
   - Call `setAgentDevice(agentId, deviceId)` (persist to Redis).
   - Update `broadcastManager`'s in-memory `selectedDevice`.
   - Emit `select_device { id: deviceId }` to the agent's socket.
   - Rebroadcast `remote_audio_sources` so all clients observe the new selection.

3. New handler `refresh_devices { socketId }` (admin → server): forward a `refresh_devices` event to the target agent's socket. No state change yet — the agent's next `register_audio_source` emit drives the update.

4. `disconnect` handler ([current location: `backend/src/sockets/translation.socket.ts:1215`](backend/src/sockets/translation.socket.ts#L1215)): unchanged. Source is removed from the live list; Redis selection key persists for the next reconnect.

#### `services/redis.service.ts`

Add two thin helpers, modelled on the existing `getSetting` / `setSetting`:

```ts
export const getAgentDevice = (agentId: string) =>
  getSetting<string>(`agent_device:${agentId}`);
export const setAgentDevice = (agentId: string, deviceId: string) =>
  setSetting(`agent_device:${agentId}`, deviceId);
```

### Frontend (`live-translator-node/frontend`)

#### `hooks/useSocket.ts` + `contexts/SocketContext.tsx`

Extend the `RemoteAudioSource` type:

```ts
interface RemoteAudioSource {
  socketId: string;
  agentId: string;              // new
  label: string;                // existing
  devices: { id: string; name: string }[];   // new
  selectedDevice: string | null;              // new
}
```

Existing code paths that read only `label` continue to work.

#### `pages/AdminView.tsx`

Inside the Connected Agent Sources list ([`AdminView.tsx:1277-1288`](frontend/src/pages/AdminView.tsx#L1277-L1288)), replace the single-row display with row + inline `<select>`:

- `<select>` options come from `src.devices`; `value = src.selectedDevice ?? ''`; leading option is `-- select device --` when null.
- `onChange` emits `select_agent_device { socketId: src.socketId, deviceId: e.target.value }`. No optimistic local update — server rebroadcast drives state within a round trip.
- Refresh button (🔄) emits `refresh_devices { socketId: src.socketId }`.
- Error banner row: on `device_select_error` or `audio_stream_error` events matching this `socketId`, show a dismissable red line under the row until the next successful selection.

At the Start Broadcast button ([`AdminView.tsx:1303`](frontend/src/pages/AdminView.tsx#L1303)): extend the disabled condition. In Agent mode, also disable when the chosen source's `selectedDevice === null`. Tooltip: "Pick an input device first."

No other UI surfaces touch the new fields.

## Data & contracts

### New / changed socket events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `register_audio_source` | agent → server | `{ agentId, label, deviceId, devices, selectedDevice }` | Backward-compatible superset of the existing payload. |
| `remote_audio_sources` | server → all | `{ sources: RemoteAudioSource[] }` | Each source now carries `devices` and `selectedDevice`. |
| `select_agent_device` | admin → server | `{ socketId, deviceId }` | New. Admin-authenticated. |
| `select_device` | server → agent | `{ id }` | New. Tells the agent to swap to a specific device. |
| `refresh_devices` (admin leg) | admin → server | `{ socketId }` | New. Server routes to the target agent socket. |
| `refresh_devices` (agent leg) | server → agent | `{}` | New. Agent re-runs `system_profiler` and re-emits `register_audio_source`. |
| `device_select_error` | server → admin | `{ socketId, message }` | New. Returned only to the admin socket that initiated the selection. |
| `audio_stream_error` | agent → server → admin | `{ deviceId, message }` | New. Agent reports runtime capture failure; server surfaces to admins viewing that source. |

### Redis keys

| Key | Value | TTL |
|---|---|---|
| `setting:agent_device:<agentId>` | device id string | none (persists until overwritten) |

## Error handling

- **`system_profiler` fails or returns unexpected JSON**: agent registers with `devices: []`. Admin UI shows the dropdown with only the placeholder and tooltip "agent reports no input devices — plug one in and refresh."
- **Stale selection (device removed between `register` and `select_agent_device`)**: backend rejects via `device_select_error`; UI surfaces message and re-syncs the dropdown from the most recent `remote_audio_sources`.
- **Sox fails to open the selected device at `startStreaming`**: agent emits `audio_stream_error`, stops streaming, keeps `selectedDevice` as-is. Admin sees a red banner; re-picking the same or a different device retries.
- **Redis unavailable during `setAgentDevice`**: handler logs the error and still emits `select_device` to the agent so the choice takes effect for the live session. The persistence simply does not happen; next reconnect will fall back to whatever the agent reports.

## Testing

**Agent unit tests** (new):

- Mock `system_profiler` stdout fixtures (devices present, empty, malformed); assert parsing.
- Assert `state.json` creation on first run and reuse on subsequent runs.
- Assert `select_device` with an unknown id triggers `audio_stream_error` and does not restart recording.

**Backend unit tests** (extend existing socket tests):

- `register_audio_source` with a persisted Redis key adopts the persisted device and emits `select_device` when the agent's reported `selectedDevice` differs.
- `select_agent_device` validates membership, persists to Redis, emits both `select_device` (to agent) and updated `remote_audio_sources` (broadcast).
- Missing socketId → `device_select_error`.

**Integration (manual, once implemented)**:

1. Agent running on this Mac, no persisted selection. Admin UI shows the agent with built-in mic as the only option; pick it; start broadcast; confirm audio.
2. Plug in a USB mic mid-session. Click refresh. Pick the USB mic while broadcasting. Confirm the active stream switches within ~1 second and audio continues from the new mic (a brief gap is acceptable).
3. Stop broadcast. Restart the agent (`brew services restart live-translator-agent`). Confirm that on reconnect the agent resumes on the USB mic without admin intervention.
4. Unplug the USB mic and restart the agent again. Confirm the agent registers with the reduced `devices[]`; the admin UI shows the previous selection as unavailable; picking a different device works.

## Rollout

Order matters because the backend is backward-compatible with old agents (they'll just register with no `devices[]`), but a new agent emitting the extended payload to an old backend would have its extra fields silently ignored and never reach the UI.

1. **`live-translator-node`** — land backend + frontend changes. CI → GHCR → ArgoCD Image Updater auto-rolls the `live-translator` Deployment. Old agents keep working; admin UI renders an empty dropdown for any source missing `devices[]`.
2. **`live-translator-agent`** — land daemon.js changes. Tag a new release (e.g. `v1.1.0`). GitHub's "Releases" page publishes a `.tar.gz` for the tag.
3. **`Pzharyuk/homebrew-tools`** — open a PR updating [`Formula/live-translator-agent.rb`](https://github.com/Pzharyuk/homebrew-tools/blob/main/Formula/live-translator-agent.rb):
   - `url` bumped to `https://github.com/Pzharyuk/live-translator-agent/archive/refs/tags/v1.1.0.tar.gz`.
   - `sha256` updated to the new tarball's checksum (`curl -sSL <url> | shasum -a 256`).
   - Drop the `revision 1` line (the version bump itself triggers an upgrade path; a `revision` is only needed for formula-only fixes without a version change).
4. **This Mac** — `brew update && brew upgrade live-translator-agent && brew services restart live-translator-agent`. The agent re-registers with the extended payload; the UI populates.

No data migration required (new Redis keys are created on first selection, no migration of existing records). If step 2 lands before step 1 (e.g. PR ordering), the only impact is that the new agent's extra fields are ignored by the old backend until step 1 rolls — no breakage.
