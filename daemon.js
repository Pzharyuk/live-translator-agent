#!/usr/bin/env node
'use strict';

const { io } = require('socket.io-client');
const recorder = require('node-record-lpcm16');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync, spawn } = require('child_process');
const { parseAudioDevices } = require('./scripts/parse-audio-devices');
const { createCaptureGuard } = require('./capture-guard');

// ---------------------------------------------------------------------------
// CLI subcommands — these short-circuit the daemon and exit
// ---------------------------------------------------------------------------

const SOX_BIN = '/opt/homebrew/bin/sox';

/**
 * macOS-specific helper. Opens System Settings → Privacy & Security →
 * Microphone and prints exact steps to grant the sox binary permission.
 * Then runs sox once interactively so macOS files Terminal's grant in
 * TCC (helps if the user adds sox manually but Terminal isn't already
 * authorised either).
 *
 * Background: launchd-spawned processes don't get the standard mic
 * permission prompt — macOS silently kills sox the moment it tries to
 * open coreaudio. The fix is a manual entry in Privacy & Security for
 * the sox binary itself, which this helper makes discoverable.
 */
function grantMicCommand() {
  if (process.platform !== 'darwin') {
    console.log('This helper is macOS-only. On Linux/Windows mic permissions are managed differently.');
    process.exit(0);
  }
  console.log('=== live-translator-agent: macOS mic permission helper ===');
  console.log();
  console.log('Opening System Settings → Privacy & Security → Microphone...');
  spawnSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
  console.log();
  console.log('In that panel:');
  console.log('  1. Click the "+" button below the list (unlock with TouchID/password if needed)');
  console.log('  2. Press  Cmd+Shift+G  in the file picker');
  console.log(`  3. Paste:  ${SOX_BIN}`);
  console.log('  4. Click Open, then toggle the new "sox" entry ON');
  console.log();
  console.log('Then restart the agent:');
  console.log('  brew services restart live-translator-agent');
  console.log();
  console.log('Why this is needed: launchd-spawned processes don\'t trigger the standard');
  console.log('macOS mic permission prompt. Terminal-context sox works (Terminal has its own');
  console.log('grant), but the brew service runs under launchd which silently kills sox until');
  console.log('the sox binary itself is in the Microphone list.');
  process.exit(0);
}

if (process.argv[2] === '--grant-mic' || process.argv[2] === '--mic-permission') {
  grantMicCommand();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE_PATH = path.join(
  os.homedir(),
  '.config',
  'live-translator-agent',
  'state.json',
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'live-translator-agent',
  'config.json'
);

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`[Agent] Cannot read config at ${CONFIG_PATH}: ${err.message}`);
  console.error('[Agent] Run ./install.sh first, or create the config manually.');
  process.exit(1);
}

const { serverUrl, label = 'Mac Daemon' } = config;
if (!serverUrl) {
  console.error('[Agent] Config is missing "serverUrl". Edit ' + CONFIG_PATH);
  process.exit(1);
}

// Optional input-channel selector for multi-channel coreaudio devices.
// Sox's default downmix AVERAGES all channels (divides each by N), so a
// single mic on ch 1 of an 18-channel device arrives ~24 dB down and
// reaches the server as silence. The `channel` config setting selects
// which input channels feed the mono output via sox's `remix` effect:
//
//   number 1          → just channel 1
//   string "1-8"      → sum channels 1 through 8 (sox range shorthand)
//   string "1,3,5"    → sum channels 1, 3, and 5
//   array [1,3,5]     → same as "1,3,5"
//
// `remix` SUMS (does not average), so silent channels contribute 0 and
// any active channel passes through at full amplitude. Use a range when
// audio can arrive on any of several inputs (e.g. a mixer feeding the
// AudioBox on different channels per song).
function normalizeChannelSpec(value) {
  if (value == null || value === '' || value === 0) return '';
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const ints = value.filter((n) => Number.isInteger(n) && n > 0);
    return ints.length ? ints.join(',') : '';
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, '');
    if (/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cleaned)) return cleaned;
    console.warn(`[Agent] Ignoring invalid channel spec "${value}" — expected number, "1-8", "1,3,5", or array.`);
  }
  return '';
}

const channelSpec = normalizeChannelSpec(config.channel);

// sox coreaudio input buffer size (bytes). sox's coreaudio driver fills a
// ring from the audio callback while sox's main loop drains it toward
// stdout. When that loop stalls briefly (stdout backpressure from the
// socket, a GC pause, a large Buffer.concat), the ring overruns and sox
// logs "coreaudio: unhandled buffer overrun. Data discarded" — audio is
// silently dropped and the server's watchdog then flags the feed stalled.
// sox's default processing buffer is only 8192 bytes (~256ms at 16k mono);
// a larger `--buffer` gives the loop much more slack per iteration. Tunable
// via config so it can be adjusted on-device without a rebuild; 0 keeps
// sox's default.
function normalizeBufferBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 131072;
  if (n === 0) return 0; // explicit opt-out — use sox default
  // Clamp to a sane floor so a tiny value can't make overruns worse.
  return Math.max(16384, Math.floor(n));
}

const soxBufferBytes = normalizeBufferBytes(config.soxBufferBytes ?? 131072);

// Pre-shared key — required by servers that enforce agent auth. Falls back
// to the AGENT_PSK env var so the launchd plist or shell can override the
// on-disk value without rewriting config.json.
const agentPsk = (process.env.AGENT_PSK || config.agentPsk || '').trim();
if (!agentPsk) {
  console.warn('[Agent] No agentPsk in config and AGENT_PSK env unset — server may reject the registration.');
}

function loadOrCreateAgentId() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (typeof state.agentId === 'string' && state.agentId.length > 0) {
      return state.agentId;
    }
  } catch {
    // state.json missing or malformed — generate a fresh id below
  }
  const agentId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ agentId }, null, 2) + '\n');
  console.log(`[Agent] Generated new agentId ${agentId} (stored in ${STATE_PATH})`);
  return agentId;
}

const agentId = loadOrCreateAgentId();

function enumerateDevices() {
  try {
    const raw = execFileSync('system_profiler', ['SPAudioDataType', '-json'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const devices = parseAudioDevices(raw);
    console.log(`[Agent] Enumerated ${devices.length} input device(s)`);
    return devices;
  } catch (err) {
    console.error(`[Agent] Device enumeration failed: ${err.message}`);
    return [];
  }
}

let devices = enumerateDevices();
let selectedDevice = null;
let refreshInFlight = false;

const DEVICE_ID = 'mac-daemon-mic';
// 4096 int16 samples × 2 bytes = 8192 bytes ≈ 250 ms at 16 kHz — matches browser chunk size
const CHUNK_SIZE = 8192;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let recording = null;
let isStreaming = false;
let audioBuffer = Buffer.alloc(0);

// Guarantees a single audio-capture (sox) process at a time. Tracks spawned
// captures and force-kills leftovers so a restart/source-toggle can't leave
// two sox feeding the socket (which doubled audio into Scribe → duplicate
// transcripts). See capture-guard.js.
const captureGuard = createCaptureGuard();

// ---------------------------------------------------------------------------
// Socket.io connection
// ---------------------------------------------------------------------------

console.log(`[Agent] Connecting to ${serverUrl}`);

const socket = io(serverUrl, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000,
  auth: { agentPsk },
});

socket.on('agent_auth_error', (err) => {
  console.error(`[Agent] Server rejected registration: ${err?.message || 'invalid PSK'}`);
  console.error(`[Agent] Fix the agentPsk in ${CONFIG_PATH} (or AGENT_PSK env var) and restart.`);
});

socket.on('connect', () => {
  console.log(`[Agent] Connected (${socket.id})`);
  socket.emit('register_audio_source', {
    agentId,
    label,
    deviceId: DEVICE_ID,
    devices,
    selectedDevice,
  });
  console.log(`[Agent] Registered as audio source: "${label}" (${devices.length} device(s), selected=${selectedDevice ?? 'none'})`);
});

socket.on('disconnect', (reason) => {
  console.log(`[Agent] Disconnected: ${reason}`);
  stopStreaming();
});

socket.on('connect_error', (err) => {
  console.error(`[Agent] Connection error: ${err.message}`);
});

// The backend broadcasts broadcast_status to ALL connected sockets whenever
// the broadcast state changes. active:true + source:'remote' means we should
// be the one streaming. Any other state means stop.
socket.on('broadcast_status', (data) => {
  const shouldStream = data.active && data.source === 'remote';

  if (shouldStream && !isStreaming) {
    console.log('[Agent] Broadcast started (remote) — starting mic stream');
    startStreaming();
  } else if (!shouldStream && isStreaming) {
    const reason = !data.active ? 'broadcast stopped' : `source changed to "${data.source}"`;
    console.log(`[Agent] ${reason} — stopping mic stream`);
    stopStreaming();
  }
});

socket.on('select_device', (data) => {
  // Socket.io dispatches events sequentially — stopStreaming()/startStreaming()
  // below cannot be reentered by another select_device or refresh_devices.
  const id = data?.id;
  if (!id) return;
  if (!devices.some((d) => d.id === id)) {
    socket.emit('audio_stream_error', { deviceId: id, message: 'device not available on this agent' });
    return;
  }
  if (id === selectedDevice) return;

  console.log(`[Agent] Switching selected device ${selectedDevice ?? 'none'} → ${id}`);
  const wasStreaming = isStreaming;
  if (wasStreaming) stopStreaming();
  selectedDevice = id;
  if (wasStreaming) startStreaming();
});

socket.on('refresh_devices', () => {
  if (refreshInFlight) {
    console.log('[Agent] refresh_devices already in flight — ignoring');
    return;
  }
  refreshInFlight = true;
  try {
    console.log('[Agent] Re-enumerating devices on admin request');
    devices = enumerateDevices();
    if (selectedDevice && !devices.some((d) => d.id === selectedDevice)) {
      console.log(`[Agent] Previously selected device ${selectedDevice} is gone — clearing selection`);
      selectedDevice = null;
      if (isStreaming) stopStreaming();
    }
    socket.emit('register_audio_source', {
      agentId,
      label,
      deviceId: DEVICE_ID,
      devices,
      selectedDevice,
    });
  } finally {
    refreshInFlight = false;
  }
});

// ---------------------------------------------------------------------------
// Audio capture
// ---------------------------------------------------------------------------

/**
 * Translate an empty/cryptic stream error into a clear actionable
 * message. Two known sox failure modes look identical at the JS layer
 * (fast exit, no stderr, zero bytes): (a) macOS TCC mic-permission
 * denial, (b) sox's stderr leaking the "no default audio device"
 * message that means the device-name path is broken. We distinguish
 * by inspecting the captured stderr string when we have one.
 */
function diagnoseStreamError(err, msSinceStart, bytesReceived, stderrBuf) {
  const rawMsg = err?.message ?? '';
  const stderr = (stderrBuf ?? '').toString();
  // sox's "no default audio device configured" fires when we set
  // AUDIODEV to a named device on macOS (node-record-lpcm16's path).
  if (/no default audio device/i.test(stderr)) {
    return 'sox could not open the selected device by name. The agent will fall back to direct coreaudio spawn on next start.';
  }
  // sox's "Permission denied" stderr is the cleanest TCC signal.
  if (/permission denied|operation not permitted/i.test(stderr)) {
    return [
      'macOS Microphone permission denied for sox.',
      `Add ${SOX_BIN} to System Settings → Privacy & Security → Microphone.`,
      'Run "live-translator-agent --grant-mic" for step-by-step instructions.',
    ].join(' ');
  }
  // Fall back to the heuristic: fast empty-stderr exit on macOS most
  // often means TCC (the silent-kill pattern).
  const looksLikeTccDenial =
    process.platform === 'darwin' &&
    bytesReceived === 0 &&
    msSinceStart < 800 &&
    (!rawMsg || rawMsg.trim() === '' || /exited|killed|signal/i.test(rawMsg));
  if (looksLikeTccDenial) {
    return [
      'sox died fast with no output. Most likely macOS Microphone permission denial for the launchd-spawned process.',
      `Add ${SOX_BIN} to System Settings → Privacy & Security → Microphone (run "live-translator-agent --grant-mic" for steps).`,
      'If permission is already granted, the device may not be physically producing audio — check cable/gain on the audio interface.',
    ].join(' ');
  }
  return rawMsg || stderr.trim() || 'Unknown audio stream error (sox died with no message)';
}

/**
 * macOS-specific direct sox capture. Skips node-record-lpcm16 because
 * its AUDIODEV-env-var device selection is treated by sox as an output
 * type name (not a coreaudio device name), causing "no default audio
 * device configured" errors when a named device is selected.
 *
 * Spawns sox directly with `-t coreaudio "Device Name"` which is the
 * documented way to pick a specific coreaudio input device. Streams
 * 16 kHz / 16-bit / mono signed PCM on stdout.
 *
 * Returns an object with the same shape as node-record-lpcm16's
 * recorder so the caller's stream() interface works unchanged.
 */
function startSoxCoreaudio(deviceName) {
  const args = [];
  // `--buffer` is a GLOBAL option — it must precede the input spec. Enlarges
  // sox's processing buffer to absorb brief stdout stalls without the
  // coreaudio ring overrunning (see soxBufferBytes above).
  if (soxBufferBytes > 0) {
    args.push('--buffer', String(soxBufferBytes));
  }
  args.push(
    '-t', 'coreaudio', deviceName,
    '-r', '16000',
    '-c', '1',
    '-b', '16',
    '-e', 'signed-integer',
    '-t', 'raw',
    '-', // stdout
  );
  // `remix` is a sox EFFECT, so it goes after the output spec. With a
  // single channel it isolates that input; with a range/list (e.g.
  // "1-8") it SUMS those channels into the mono output — neither path
  // applies the 1/N attenuation that the default downmix would.
  if (channelSpec) {
    args.push('remix', channelSpec);
  }
  const child = spawn(SOX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Track this capture so leftovers can be force-killed before the next start.
  captureGuard.register(child);
  return {
    process: child,
    stream: () => child.stdout,
    stderr: child.stderr,
    // Reliable stop: SIGTERM, then SIGKILL if sox lingers (a large --buffer can
    // make it slow to exit). Fire-and-forget SIGTERM was how the old sox
    // outlived a stopStreaming() and became a duplicate on the next start.
    stop: () => captureGuard.forceKill(child),
  };
}

function startStreaming() {
  if (isStreaming) return;
  isStreaming = true;
  // Belt-and-suspenders: kill any capture that leaked from a previous cycle
  // BEFORE spawning the new one, so two sox can never coexist.
  captureGuard.sweep(null);
  // Tag this capture; a stale sox's delayed exit handler checks its own gen
  // and bails instead of corrupting this capture's state.
  const myGen = captureGuard.nextGen();
  audioBuffer = Buffer.alloc(0);
  let bytesReceived = 0;
  const startedAt = Date.now();
  let stderrBuf = '';

  const deviceName = devices.find((d) => d.id === selectedDevice)?.name;

  // macOS-specific: when a named device is selected, spawn sox directly
  // with `-t coreaudio "Name"` because node-record-lpcm16's AUDIODEV
  // approach doesn't translate to coreaudio device names. Default
  // device + Linux all stay on the library's normal path.
  const useDirectSox = process.platform === 'darwin' && deviceName;

  try {
    if (useDirectSox) {
      recording = startSoxCoreaudio(deviceName);
      recording.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      recording.stream()
        .on('data', (chunk) => {
          bytesReceived += chunk.length;
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
          while (audioBuffer.length >= CHUNK_SIZE) {
            const slice = audioBuffer.subarray(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.subarray(CHUNK_SIZE);
            socket.emit('audio_chunk', { audio: slice.toString('base64') });
          }
        })
        .on('error', (err) => emitStreamError(err));
      recording.process.on('exit', (code, signal) => {
        // A newer capture already owns the state — this is a stale/leftover sox
        // exiting (e.g. one we just swept). Ignore so it can't tear down the
        // live capture.
        if (!captureGuard.isCurrent(myGen)) return;
        if (!isStreaming) return; // intentional stop
        // sox exiting on its own = error path
        const msSinceStart = Date.now() - startedAt;
        const synthMsg = stderrBuf || `sox exited (code=${code} signal=${signal})`;
        emitStreamError({ message: synthMsg });
      });
      console.log(`[Agent] Mic capture running (16 kHz, 16-bit mono PCM) on ${deviceName} [direct coreaudio${channelSpec ? `, remix ${channelSpec}` : ''}${soxBufferBytes > 0 ? `, buffer ${soxBufferBytes}B` : ''}]`);
    } else {
      const recordOpts = {
        sampleRate: 16000,
        channels: 1,
        audioType: 'raw',
        encoding: 'signed-integer',
        bits: 16,
      };
      recording = recorder.record(recordOpts);
      recording
        .stream()
        .on('data', (chunk) => {
          bytesReceived += chunk.length;
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
          while (audioBuffer.length >= CHUNK_SIZE) {
            const slice = audioBuffer.subarray(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.subarray(CHUNK_SIZE);
            socket.emit('audio_chunk', { audio: slice.toString('base64') });
          }
        })
        .on('error', (err) => emitStreamError(err));
      console.log(`[Agent] Mic capture running (16 kHz, 16-bit mono PCM) on default device`);
    }
  } catch (err) {
    emitStreamError(err);
    return;
  }

  function emitStreamError(err) {
    if (!isStreaming) return; // already torn down
    const msSinceStart = Date.now() - startedAt;
    const message = diagnoseStreamError(err, msSinceStart, bytesReceived, stderrBuf);
    console.error(`[Agent] Audio stream error: ${message} (raw="${err?.message ?? ''}", stderr="${stderrBuf.slice(0, 200).trim()}", bytes=${bytesReceived}, ms=${msSinceStart})`);
    socket.emit('audio_stream_error', {
      deviceId: selectedDevice ?? '',
      message,
    });
    isStreaming = false;
    recording = null;
  }
}

function stopStreaming() {
  if (!isStreaming) return;
  isStreaming = false;
  audioBuffer = Buffer.alloc(0);
  // Invalidate any in-flight capture: a lingering sox's exit handler will now
  // see a newer generation and bail.
  captureGuard.nextGen();

  if (recording) {
    try {
      recording.stop();
    } catch {
      // ignore errors on cleanup
    }
    recording = null;
  }
  // Final guard: force-kill anything still tracked (covers the non-direct-sox
  // recorder path and any straggler).
  captureGuard.sweep(null);

  console.log('[Agent] Mic capture stopped');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[Agent] ${signal} — shutting down`);
  stopStreaming();
  socket.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
