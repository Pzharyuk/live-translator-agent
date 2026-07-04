/*
 * capture-guard.js
 *
 * Guarantees the agent never runs more than one audio-capture (sox) process
 * at a time. The daemon used to leak a second sox when a restart/source-toggle
 * spawned a new capture before the previous one had actually died (a
 * fire-and-forget SIGTERM that a slow sox — slower with a large --buffer —
 * outlived). Two captures fed the one socket, doubling audio into Scribe and
 * duplicating transcripts.
 *
 * This guard provides:
 *   - register(child): track a spawned capture; auto-untracked on its exit.
 *   - forceKill(child): SIGTERM, then SIGKILL after killDelayMs if it lingers.
 *   - sweep(except):    force-kill every tracked child except `except`
 *                       (call with null before spawning a new capture).
 *   - nextGen()/isCurrent(gen): generation tokens so a stale capture's delayed
 *                       exit handler can't corrupt the state of a newer one.
 *
 * Pure and side-effect-free on load (safe to unit test): it only touches the
 * child processes handed to it.
 */

function createCaptureGuard({ killDelayMs = 400 } = {}) {
  const live = new Set();
  let gen = 0;

  function isAlive(child) {
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  function register(child) {
    if (!child) return child;
    live.add(child);
    // node ChildProcess emits 'exit'; our fake test child does too.
    if (typeof child.on === 'function') {
      child.on('exit', () => live.delete(child));
    }
    return child;
  }

  function forceKill(child) {
    if (!isAlive(child)) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const t = setTimeout(() => {
      if (isAlive(child)) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, killDelayMs);
    // Don't keep the event loop alive just for the escalation timer.
    if (t && typeof t.unref === 'function') t.unref();
  }

  function sweep(except) {
    for (const child of live) {
      if (child === except) continue;
      forceKill(child);
    }
  }

  function nextGen() { return ++gen; }
  function isCurrent(g) { return g === gen; }

  return {
    register,
    forceKill,
    sweep,
    nextGen,
    isCurrent,
    get size() { return live.size; },
  };
}

module.exports = { createCaptureGuard };
