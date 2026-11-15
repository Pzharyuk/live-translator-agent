#!/usr/bin/env node
'use strict';

// Compare sox stdout delivery for the v1.4.2 buffer vs the split buffers.
//
// Generates SECONDS of 16 kHz 16-bit mono PCM, paces it at realtime
// (32000 bytes/s) with `pv -L 32000`, and feeds it to sox using the same
// global buffer flags the daemon passes. The input type is raw, not
// coreaudio — Linux has no coreaudio, and SoX's coreaudio ring is sized
// from `--buffer` rather than `--input-buffer` (see README).
//
// Reads are Node `child.stdout` 'data' events with the default 64 KiB
// highWaterMark, which is how daemon.js reads sox.
//
// Usage: node scripts/bench-sox-buffer.js [seconds]

const { spawn, execFileSync } = require('child_process');
const { buildCoreaudioSoxArgs, percentileNearestRank } = require('../sox-args');

const SECONDS = Number(process.argv[2] || 60);
const RATE_BYTES = 32000; // 16 kHz * 16-bit * mono

function flagsFor(bufferBytes, inputBufferBytes) {
  const { args } = buildCoreaudioSoxArgs({
    deviceName: 'bench',
    bufferBytes,
    inputBufferBytes,
    inputBufferSupported: inputBufferBytes > 0,
  });
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-t' && args[i + 1] === 'coreaudio') break;
    flags.push(args[i]);
  }
  return flags;
}

function percentile(sorted, p) {
  return percentileNearestRank(sorted, p);
}

function summarize(name, flags, events, elapsedMs) {
  const sizes = events.map((e) => e.n);
  const gaps = [];
  for (let i = 1; i < events.length; i += 1) gaps.push(events[i].t - events[i - 1].t);
  const sg = gaps.slice().sort((a, b) => a - b);
  const ss = sizes.slice().sort((a, b) => a - b);
  const stalls = sg.filter((g) => g >= 50);
  const hist = {};
  for (const n of sizes) hist[n] = (hist[n] || 0) + 1;
  const round = (n) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    name,
    flags,
    reads: events.length,
    totalBytes: sizes.reduce((a, b) => a + b, 0),
    elapsedMs: Math.round(elapsedMs),
    gapMs: {
      n: sg.length,
      p50: round(percentile(sg, 0.5)),
      p95: round(percentile(sg, 0.95)),
      max: round(sg.length ? sg[sg.length - 1] : null),
      p50OfGapsAtLeast50ms: round(percentile(stalls, 0.5)),
    },
    bytesPerRead: {
      p50: percentile(ss, 0.5),
      p95: percentile(ss, 0.95),
      max: ss.length ? ss[ss.length - 1] : null,
      min: ss.length ? ss[0] : null,
    },
    sizeHist: hist,
  };
}

function run(name, flags) {
  return new Promise((resolve, reject) => {
    const gen = spawn('sox', [
      '-q', '-n', '-r', '16000', '-b', '16', '-c', '1', '-e', 'signed-integer', '-t', 'raw', '-',
      'synth', String(SECONDS), 'sine', '440',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const pv = spawn('pv', ['-q', '-L', String(RATE_BYTES)], { stdio: ['pipe', 'pipe', 'inherit'] });
    const soxArgs = [
      '-q',
      ...flags,
      '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
      '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
    ];
    const sox = spawn('sox', soxArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    let err = '';
    sox.stderr.on('data', (d) => { err += d.toString(); });
    gen.stderr.on('data', () => {});
    gen.stdout.pipe(pv.stdin);
    pv.stdout.pipe(sox.stdin);

    const events = [];
    const t0 = process.hrtime.bigint();
    sox.stdout.on('data', (chunk) => {
      const t = Number(process.hrtime.bigint() - t0) / 1e6;
      events.push({ t, n: chunk.length });
    });

    const fail = (e) => reject(e);
    gen.on('error', fail);
    pv.on('error', fail);
    sox.on('error', fail);
    sox.on('close', (code) => {
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      if (code !== 0) {
        const error = new Error(`${name} sox exited ${code}: ${err.slice(0, 400)}`);
        reject(error);
        return;
      }
      resolve(summarize(name, flags, events, elapsed));
    });
  });
}

(async () => {
  const cases = [
    ['old --buffer 131072', flagsFor(131072, 0)],
    ['new --input-buffer 131072 --buffer 8192', flagsFor(8192, 131072)],
    ['control --buffer 8192 (no input-buffer)', flagsFor(8192, 0)],
  ];
  const results = [];
  for (const [name, flags] of cases) {
    process.stderr.write(`running ${name} (${SECONDS}s)\n`);
    results.push(await run(name, flags));
  }
  let soxVersion = '';
  try {
    soxVersion = execFileSync('sox', ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    soxVersion = (err.stdout || err.message || '').toString().trim();
  }
  console.log(JSON.stringify({
    seconds: SECONDS,
    rateBytesPerSec: RATE_BYTES,
    sox: soxVersion,
    note: 'coreaudio was not exercised; input is a paced raw pipe. Reads use Node default highWaterMark (64 KiB).',
    results,
  }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
