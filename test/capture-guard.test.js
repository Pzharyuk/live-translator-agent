/*
 * Tests for capture-guard.js — the single-capture guarantee that prevents
 * duplicate sox processes. Run: node test/capture-guard.test.js
 * No test framework (agent has none); plain asserts + a tiny runner.
 */
const assert = require('assert');
const { createCaptureGuard } = require('../capture-guard');

// A fake child process mimicking the bits capture-guard touches.
function fakeChild({ ignoreSigterm = false } = {}) {
  const handlers = {};
  return {
    exitCode: null,
    signalCode: null,
    signalsReceived: [],
    on(ev, fn) { handlers[ev] = fn; return this; },
    kill(sig) {
      this.signalsReceived.push(sig);
      // A well-behaved child dies on SIGTERM; a stuck one only dies on SIGKILL.
      if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !ignoreSigterm)) this._exit(sig);
      return true;
    },
    _exit(sig) {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = sig || 'SIGTERM';
      if (handlers.exit) handlers.exit(null, this.signalCode);
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('register tracks a child and untracks it on exit', () => {
  const g = createCaptureGuard();
  const c = fakeChild();
  g.register(c);
  assert.strictEqual(g.size, 1, 'child tracked after register');
  c._exit('SIGTERM');
  assert.strictEqual(g.size, 0, 'child untracked after exit');
});

test('forceKill sends SIGTERM and the child exits (no SIGKILL needed)', () => {
  const g = createCaptureGuard({ killDelayMs: 20 });
  const c = fakeChild();
  g.register(c);
  g.forceKill(c);
  assert.deepStrictEqual(c.signalsReceived, ['SIGTERM'], 'only SIGTERM for well-behaved child');
});

test('forceKill escalates to SIGKILL when SIGTERM is ignored', (done) => {
  const g = createCaptureGuard({ killDelayMs: 20 });
  const c = fakeChild({ ignoreSigterm: true });
  g.register(c);
  g.forceKill(c);
  assert.deepStrictEqual(c.signalsReceived, ['SIGTERM'], 'SIGTERM first');
  setTimeout(() => {
    assert.ok(c.signalsReceived.includes('SIGKILL'), 'SIGKILL after timeout');
    assert.notStrictEqual(c.signalCode, null, 'child ended after SIGKILL');
    done();
  }, 40);
});

test('sweep kills every tracked child except the exception', () => {
  const g = createCaptureGuard({ killDelayMs: 20 });
  const stale1 = fakeChild();
  const stale2 = fakeChild();
  const keep = fakeChild();
  g.register(stale1); g.register(stale2); g.register(keep);
  g.sweep(keep);
  assert.ok(stale1.signalsReceived.length > 0, 'stale1 killed');
  assert.ok(stale2.signalsReceived.length > 0, 'stale2 killed');
  assert.strictEqual(keep.signalsReceived.length, 0, 'kept child untouched');
});

test('sweep(null) before spawning a new capture kills all leftovers', () => {
  const g = createCaptureGuard({ killDelayMs: 20 });
  const leftover = fakeChild();
  g.register(leftover);
  g.sweep(null); // startStreaming calls this before spawning the new sox
  assert.ok(leftover.signalsReceived.includes('SIGTERM'), 'leftover killed pre-start');
});

test('generation guard: only the newest capture is current', () => {
  const g = createCaptureGuard();
  const genA = g.nextGen();
  const genB = g.nextGen();
  assert.strictEqual(g.isCurrent(genB), true, 'latest gen is current');
  assert.strictEqual(g.isCurrent(genA), false, 'older gen is stale');
});

test('forceKill on an already-exited child is a no-op (no throw)', () => {
  const g = createCaptureGuard({ killDelayMs: 20 });
  const c = fakeChild();
  c._exit('SIGTERM');
  g.forceKill(c); // should not throw or re-signal
  assert.strictEqual(c.signalsReceived.length, 0, 'no signal to dead child');
});

// runner
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      if (fn.length === 1) await new Promise((res, rej) => { try { fn(res); } catch (e) { rej(e); } });
      else fn();
      console.log(`ok   - ${name}`); pass++;
    } catch (e) {
      console.log(`FAIL - ${name}\n       ${e.message}`); fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
