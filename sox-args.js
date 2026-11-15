'use strict';

// SoX buffer flags for the direct coreaudio capture path.
//
// SoX 14.4.2 (the Homebrew formula the agent invokes at /opt/homebrew/bin/sox,
// and `sox -h` on that version) accepts:
//   --buffer BYTES        size of all processing buffers (default 8192)
//   --input-buffer BYTES  override the input buffer size (default: as --buffer)
//
// `--buffer` is what stdout is fully-buffered to (`setvbuf` in formats.c) and
// what the coreaudio ring / device IO buffer is sized from (coreaudio.c uses
// sox_globals.bufsiz, and the handler is SOX_FILE_NOSTDIO). v1.4.2 set
// `--buffer 131072`, so stdout showed up in ~4 s bursts (131072 bytes of
// 16 kHz 16-bit mono) and the daemon forwarded 8192-byte chunks back to back.
//
// `--input-buffer` only changes the stdio read buffer for file/pipe inputs.
// It does not enlarge the coreaudio ring. Passing a large `--input-buffer`
// with a small `--buffer` keeps pipe reads deep and stdout blocks small.
// On the Mac capture path the ring still follows `--buffer`. Callers that
// need the old overrun slack can set soxBufferBytes back to 131072.
//
// If `sox -h` does not advertise `--input-buffer`, the flag is omitted.
// An unknown global option makes sox exit, which would drop the capture.

const { spawnSync } = require('child_process');

const DEFAULT_SOX_BUFFER_BYTES = 8192;
const DEFAULT_SOX_INPUT_BUFFER_BYTES = 131072;
// Floor is below the 8192 default so a config can go smaller (for example
// 4096) if a Mac log shows the effects quantum is longer than wanted. The
// v1.4.2 floor was 16384, which would clamp the new default back up. Sox
// itself rejects a buffer <= 16.
const MIN_SOX_BUFFER_BYTES = 1024;
// Input slack stays at the v1.4.2 floor so a tiny input buffer can't be set
// by accident. 0 still means "omit the flag".
const MIN_SOX_INPUT_BUFFER_BYTES = 16384;

function normalizeBufferBytes(value, fallback, floor) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0; // explicit opt-out — omit the flag, sox default
  return Math.max(floor, Math.floor(n));
}

function resolveSoxBufferConfig(config = {}) {
  const src = config || {};
  return {
    bufferBytes: normalizeBufferBytes(
      src.soxBufferBytes == null ? DEFAULT_SOX_BUFFER_BYTES : src.soxBufferBytes,
      DEFAULT_SOX_BUFFER_BYTES,
      MIN_SOX_BUFFER_BYTES,
    ),
    inputBufferBytes: normalizeBufferBytes(
      src.soxInputBufferBytes == null ? DEFAULT_SOX_INPUT_BUFFER_BYTES : src.soxInputBufferBytes,
      DEFAULT_SOX_INPUT_BUFFER_BYTES,
      MIN_SOX_INPUT_BUFFER_BYTES,
    ),
  };
}

function soxHelpSupportsInputBuffer(helpText) {
  return /(?:^|\s)--input-buffer\b/.test(String(helpText || ''));
}

function probeSoxInputBuffer(soxBin, spawnSyncImpl = spawnSync) {
  let result;
  try {
    result = spawnSyncImpl(soxBin, ['-h'], { encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    return { supported: false, helpText: '', error: err };
  }
  if (!result) return { supported: false, helpText: '', error: new Error('sox -h produced no result') };
  const helpText = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    supported: soxHelpSupportsInputBuffer(helpText),
    helpText,
    error: result.error || null,
  };
}

/**
 * Global options must precede the input spec. Order matches the intended
 * split: large input buffer, small output/processing buffer.
 */
function buildCoreaudioSoxArgs({
  deviceName,
  channelSpec = '',
  bufferBytes = DEFAULT_SOX_BUFFER_BYTES,
  inputBufferBytes = DEFAULT_SOX_INPUT_BUFFER_BYTES,
  inputBufferSupported = true,
} = {}) {
  const args = [];
  const warnings = [];
  if (inputBufferBytes > 0) {
    if (inputBufferSupported) {
      args.push('--input-buffer', String(inputBufferBytes));
    } else {
      const output = bufferBytes > 0 ? String(bufferBytes) : 'the sox default';
      warnings.push(
        `sox does not advertise --input-buffer; omitting the ${inputBufferBytes}B input buffer and keeping --buffer ${output}. Homebrew sox 14.4.2 supports --input-buffer.`,
      );
    }
  }
  if (bufferBytes > 0) args.push('--buffer', String(bufferBytes));
  args.push(
    '-t', 'coreaudio', deviceName,
    '-r', '16000',
    '-c', '1',
    '-b', '16',
    '-e', 'signed-integer',
    '-t', 'raw',
    '-',
  );
  // `remix` is a sox effect, so it goes after the output spec. A single
  // channel isolates that input; a range/list (e.g. "1-8") sums those
  // channels into the mono output, with no 1/N attenuation.
  if (channelSpec) args.push('remix', String(channelSpec));
  return { args, warnings };
}

function chunkStatsRequested(config = {}, env = process.env) {
  const src = config || {};
  const hasEnv = env && Object.prototype.hasOwnProperty.call(env, 'SOX_CHUNK_STATS');
  const raw = hasEnv ? env.SOX_CHUNK_STATS : undefined;
  if (raw != null && String(raw).trim() !== '') return flagOn(raw);
  return flagOn(src.soxChunkStats);
}

function flagOn(value) {
  if (value === true || value === 1) return true;
  if (value == null || value === false || value === 0) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

// Nearest-rank percentile. `sorted` must be ascending. p is in [0, 1].
function percentileNearestRank(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarizeGaps(gaps, sizes) {
  if (!gaps.length) return null;
  const g = gaps.slice().sort((a, b) => a - b);
  const s = sizes.slice().sort((a, b) => a - b);
  return {
    n: g.length,
    p50: percentileNearestRank(g, 0.5),
    p95: percentileNearestRank(g, 0.95),
    max: g[g.length - 1],
    bytesP50: s.length ? percentileNearestRank(s, 0.5) : null,
  };
}

function formatChunkGapStats(stats) {
  const ms = (n) => String(Math.round(n));
  const bytes = stats.bytesP50 == null ? '' : ` bytesP50=${Math.round(stats.bytesP50)}`;
  return `[Agent] sox stdout chunk gaps: n=${stats.n} p50=${ms(stats.p50)}ms p95=${ms(stats.p95)}ms max=${ms(stats.max)}ms${bytes}`;
}

/**
 * Records inter-arrival times of sox stdout reads. Off unless `enabled`.
 * Reports once per `intervalMs` (default 60s). The timer is unref'd so it
 * does not keep the process alive by itself.
 */
function createChunkGapTracker({
  enabled = false,
  intervalMs = 60000,
  now = Date.now,
  onReport = () => {},
  timer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const gaps = [];
  const sizes = [];
  let lastAt = null;
  let handle = null;

  function report() {
    if (!enabled || gaps.length === 0) return null;
    const stats = summarizeGaps(gaps, sizes);
    gaps.length = 0;
    sizes.length = 0;
    onReport(stats);
    return stats;
  }

  if (enabled && intervalMs > 0) {
    handle = timer(() => { report(); }, intervalMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  return {
    note(byteLength, at = now()) {
      if (!enabled) return;
      if (lastAt != null) gaps.push(at - lastAt);
      sizes.push(byteLength);
      lastAt = at;
    },
    report,
    stop() {
      if (handle != null) clearTimer(handle);
      handle = null;
    },
  };
}

module.exports = {
  DEFAULT_SOX_BUFFER_BYTES,
  DEFAULT_SOX_INPUT_BUFFER_BYTES,
  MIN_SOX_BUFFER_BYTES,
  MIN_SOX_INPUT_BUFFER_BYTES,
  normalizeBufferBytes,
  resolveSoxBufferConfig,
  soxHelpSupportsInputBuffer,
  probeSoxInputBuffer,
  buildCoreaudioSoxArgs,
  chunkStatsRequested,
  percentileNearestRank,
  summarizeGaps,
  formatChunkGapStats,
  createChunkGapTracker,
};
