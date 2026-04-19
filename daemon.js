#!/usr/bin/env node
'use strict';

const { io } = require('socket.io-client');
const recorder = require('node-record-lpcm16');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

const DEVICE_ID = 'mac-daemon-mic';
// 4096 int16 samples × 2 bytes = 8192 bytes ≈ 250 ms at 16 kHz — matches browser chunk size
const CHUNK_SIZE = 8192;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let recording = null;
let isStreaming = false;
let audioBuffer = Buffer.alloc(0);

// ---------------------------------------------------------------------------
// Socket.io connection
// ---------------------------------------------------------------------------

console.log(`[Agent] Connecting to ${serverUrl}`);

const socket = io(serverUrl, {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 10000,
});

socket.on('connect', () => {
  console.log(`[Agent] Connected (${socket.id})`);
  socket.emit('register_audio_source', { label, deviceId: DEVICE_ID });
  console.log(`[Agent] Registered as audio source: "${label}"`);
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

// ---------------------------------------------------------------------------
// Audio capture
// ---------------------------------------------------------------------------

function startStreaming() {
  if (isStreaming) return;
  isStreaming = true;
  audioBuffer = Buffer.alloc(0);

  try {
    recording = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: 'raw',
      encoding: 'signed-integer',
      bits: 16,
    });

    recording
      .stream()
      .on('data', (chunk) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // Emit fixed-size chunks matching the browser's ScriptProcessorNode output
        while (audioBuffer.length >= CHUNK_SIZE) {
          const slice = audioBuffer.subarray(0, CHUNK_SIZE);
          audioBuffer = audioBuffer.subarray(CHUNK_SIZE);
          socket.emit('audio_chunk', { audio: slice.toString('base64') });
        }
      })
      .on('error', (err) => {
        console.error('[Agent] Audio stream error:', err.message);
        stopStreaming();
      });

    console.log('[Agent] Mic capture running (16 kHz, 16-bit mono PCM)');
  } catch (err) {
    console.error('[Agent] Failed to start recording:', err.message);
    isStreaming = false;
    recording = null;
  }
}

function stopStreaming() {
  if (!isStreaming) return;
  isStreaming = false;
  audioBuffer = Buffer.alloc(0);

  if (recording) {
    try {
      recording.stop();
    } catch {
      // ignore errors on cleanup
    }
    recording = null;
  }

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
