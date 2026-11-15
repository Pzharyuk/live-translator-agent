/*
 * Tests for sox buffer arg building, config normalization, and stdout
 * chunk-gap stats. Run: node test/sox-args.test.js
 * No test framework (agent has none); plain asserts + a tiny runner.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const {
  DEFAULT_SOX_BUFFER_BYTES,
  DEFAULT_SOX_INPUT_BUFFER_BYTES,
  normalizeBufferBytes,
  resolveSoxBufferConfig,
  soxHelpSupportsInputBuffer,
  probeSoxInputBuffer,
  buildCoreaudioSoxArgs,
  chunkStatsRequested,
  createChunkGapTracker,
  formatChunkGapStats,
  percentileNearestRank,
} = require('../sox-args');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('defaults: large input buffer, small output buffer', () => {
  const cfg = resolveSoxBufferConfig({});
  assert.strictEqual(cfg.inputBufferBytes, 131072);
  assert.strictEqual(cfg.bufferBytes, 8192);
  assert.strictEqual(DEFAULT_SOX_INPUT_BUFFER_BYTES, 131072);
  assert.strictEqual(DEFAULT_SOX_BUFFER_BYTES, 8192);

  const { args, warnings } = buildCoreaudioSoxArgs({
    deviceName: 'AudioBox 1818 VSL',
    ...cfg,
    inputBufferSupported: true,
  });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(args.slice(0, 4), ['--input-buffer', '131072', '--buffer', '8192']);
  const t = args.indexOf('-t');
  assert.ok(t > 3, 'global buffer options precede -t');
  assert.deepStrictEqual(args.slice(t), [
    '-t', 'coreaudio', 'AudioBox 1818 VSL',
    '-r', '16000',
    '-c', '1',
    '-b', '16',
    '-e', 'signed-integer',
    '-t', 'raw',
    '-',
  ]);
});

test('existing soxBufferBytes config is still passed as --buffer', () => {
  const cfg = resolveSoxBufferConfig({ soxBufferBytes: 131072 });
  assert.strictEqual(cfg.bufferBytes, 131072, 'explicit legacy value honored');
  assert.strictEqual(cfg.inputBufferBytes, 131072, 'input default still applied');
  const { args } = buildCoreaudioSoxArgs({
    deviceName: 'Mic',
    ...cfg,
    inputBufferSupported: true,
  });
  assert.deepStrictEqual(args.slice(0, 4), ['--input-buffer', '131072', '--buffer', '131072']);
});

test('soxBufferBytes 262144 and custom input buffer pass through', () => {
  const cfg = resolveSoxBufferConfig({ soxBufferBytes: 262144, soxInputBufferBytes: 65536 });
  assert.strictEqual(cfg.bufferBytes, 262144);
  assert.strictEqual(cfg.inputBufferBytes, 65536);
});

test('0 omits that flag; both 0 omits both', () => {
  const none = resolveSoxBufferConfig({ soxBufferBytes: 0, soxInputBufferBytes: 0 });
  assert.strictEqual(none.bufferBytes, 0);
  assert.strictEqual(none.inputBufferBytes, 0);
  const { args } = buildCoreaudioSoxArgs({
    deviceName: 'Mic',
    ...none,
    inputBufferSupported: true,
  });
  assert.ok(!args.includes('--buffer'));
  assert.ok(!args.includes('--input-buffer'));
  assert.strictEqual(args[0], '-t');

  const outOnly = buildCoreaudioSoxArgs({
    deviceName: 'Mic',
    bufferBytes: 8192,
    inputBufferBytes: 0,
    inputBufferSupported: true,
  });
  assert.deepStrictEqual(outOnly.args.slice(0, 2), ['--buffer', '8192']);
  assert.ok(!outOnly.args.includes('--input-buffer'));
});

test('output floor is 1024 so 8192 and 4096 both pass (old floor was 16384)', () => {
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 8192 }).bufferBytes, 8192);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 4096 }).bufferBytes, 4096);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 100 }).bufferBytes, 1024);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 9000 }).bufferBytes, 9000);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 16384 }).bufferBytes, 16384);
});

test('input floor stays 16384; invalid values fall back to each default', () => {
  assert.strictEqual(resolveSoxBufferConfig({ soxInputBufferBytes: 100 }).inputBufferBytes, 16384);
  assert.strictEqual(resolveSoxBufferConfig({ soxInputBufferBytes: 16384 }).inputBufferBytes, 16384);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: 'nope' }).bufferBytes, 8192);
  assert.strictEqual(resolveSoxBufferConfig({ soxInputBufferBytes: -5 }).inputBufferBytes, 131072);
  assert.strictEqual(resolveSoxBufferConfig({ soxBufferBytes: -1 }).bufferBytes, 8192);
  assert.strictEqual(normalizeBufferBytes(8192.9, 8192, 8192), 8192);
});

test('null config keys use defaults; remix stays after the output spec', () => {
  const cfg = resolveSoxBufferConfig({ soxBufferBytes: null, soxInputBufferBytes: null });
  assert.strictEqual(cfg.bufferBytes, 8192);
  assert.strictEqual(cfg.inputBufferBytes, 131072);
  const { args } = buildCoreaudioSoxArgs({
    deviceName: 'Mic',
    channelSpec: '1-8',
    ...cfg,
    inputBufferSupported: true,
  });
  assert.deepStrictEqual(args.slice(-2), ['remix', '1-8']);
});

test('unsupported --input-buffer is omitted and warned, --buffer kept', () => {
  const { args, warnings } = buildCoreaudioSoxArgs({
    deviceName: 'Mic',
    bufferBytes: 8192,
    inputBufferBytes: 131072,
    inputBufferSupported: false,
  });
  assert.ok(!args.includes('--input-buffer'));
  assert.deepStrictEqual(args.slice(0, 2), ['--buffer', '8192']);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /--input-buffer/);
  assert.match(warnings[0], /8192/);
});

test('sox -h parser recognizes --input-buffer and ignores unrelated text', () => {
  const help = [
    '--buffer BYTES           Set the size of all processing buffers (default 8192)',
    '--input-buffer BYTES     Override the input buffer size (default: as --buffer)',
  ].join('\n');
  assert.strictEqual(soxHelpSupportsInputBuffer(help), true);
  assert.strictEqual(soxHelpSupportsInputBuffer('--buffer BYTES only\n'), false);
  assert.strictEqual(soxHelpSupportsInputBuffer(''), false);
});

test('probe reads sox -h and reports support from the help text', () => {
  const help = '--input-buffer BYTES     Override the input buffer size\n';
  const yes = probeSoxInputBuffer('/opt/homebrew/bin/sox', () => ({ stdout: help, stderr: '' }));
  assert.strictEqual(yes.supported, true);
  const no = probeSoxInputBuffer('/usr/bin/sox', () => ({ stdout: '--buffer BYTES\n', stderr: '', error: null }));
  assert.strictEqual(no.supported, false);
  const missing = probeSoxInputBuffer('/missing/sox', () => ({ stdout: '', stderr: '', error: new Error('spawn ENOENT') }));
  assert.strictEqual(missing.supported, false);
});

test('installed sox advertises --input-buffer when sox is on PATH', () => {
  let text = '';
  try {
    text = execFileSync('sox', ['-h'], { encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('       skip - sox not installed');
      return;
    }
    text = `${err.stdout || ''}\n${err.stderr || ''}`;
  }
  assert.strictEqual(soxHelpSupportsInputBuffer(text), true, 'sox -h should list --input-buffer');
});

test('percentile nearest-rank', () => {
  assert.strictEqual(percentileNearestRank([], 0.5), null);
  assert.strictEqual(percentileNearestRank([42], 0.95), 42);
  assert.strictEqual(percentileNearestRank([10, 20, 30, 40], 0.5), 20);
  assert.strictEqual(percentileNearestRank([10, 20, 30, 40], 0.95), 40);
});

test('chunk stats off by default; env overrides config', () => {
  assert.strictEqual(chunkStatsRequested({}, {}), false);
  assert.strictEqual(chunkStatsRequested({ soxChunkStats: true }, {}), true);
  assert.strictEqual(chunkStatsRequested({ soxChunkStats: true }, { SOX_CHUNK_STATS: '0' }), false);
  assert.strictEqual(chunkStatsRequested({ soxChunkStats: false }, { SOX_CHUNK_STATS: '1' }), true);
  assert.strictEqual(chunkStatsRequested({}, { SOX_CHUNK_STATS: 'true' }), true);
  assert.strictEqual(chunkStatsRequested({}, { SOX_CHUNK_STATS: '' }), false);
  assert.strictEqual(chunkStatsRequested({ soxChunkStats: 'yes' }, {}), true);
});

test('gap tracker reports p50/p95/max per window and stays quiet when disabled', () => {
  let timers = 0;
  const disabled = createChunkGapTracker({
    enabled: false,
    timer: () => { timers += 1; return { unref() {} }; },
  });
  disabled.note(8192);
  disabled.note(8192);
  assert.strictEqual(timers, 0);
  assert.strictEqual(disabled.report(), null);

  const reports = [];
  let scheduled;
  let cleared = false;
  let t = 1000;
  const tracker = createChunkGapTracker({
    enabled: true,
    intervalMs: 60000,
    now: () => t,
    timer: (fn) => { scheduled = fn; return { unref() {} }; },
    clearTimer: () => { cleared = true; },
    onReport: (stats) => reports.push(stats),
  });
  tracker.note(8192);
  t += 200;
  tracker.note(8192);
  t += 256;
  tracker.note(8192);
  t += 400;
  tracker.note(16384);
  scheduled();
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].n, 3);
  assert.strictEqual(reports[0].p50, 256);
  assert.strictEqual(reports[0].p95, 400);
  assert.strictEqual(reports[0].max, 400);
  assert.strictEqual(reports[0].bytesP50, 8192);
  assert.match(formatChunkGapStats(reports[0]), /p50=256ms/);
  assert.match(formatChunkGapStats(reports[0]), /p95=400ms/);
  assert.match(formatChunkGapStats(reports[0]), /max=400ms/);
  assert.match(formatChunkGapStats(reports[0]), /bytesP50=8192/);

  scheduled();
  assert.strictEqual(reports.length, 1, 'empty window does not log');

  t += 256;
  tracker.note(8192);
  const again = tracker.report();
  assert.strictEqual(again.n, 1);
  assert.strictEqual(again.p50, 256);
  tracker.stop();
  assert.strictEqual(cleared, true);
});

(async () => {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      if (fn.length === 1) await new Promise((res, rej) => { try { fn(res); } catch (e) { rej(e); } });
      else fn();
      console.log(`ok   - ${name}`);
      pass += 1;
    } catch (e) {
      console.log(`FAIL - ${name}\n       ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
