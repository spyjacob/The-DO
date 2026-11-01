// Keep ordered follow-ups per session on the server, independent of browser lifetime.
// Pending messages are intentionally not persisted across a server restart.
export function createMessageQueue() {
  const active = new Map();
  const held = new Set(); // paused sessions: queued messages wait for release()
  async function drain(id, entry, task) {
    try { await task.run(); }
    catch (e) { task.onError(e); }
    finally {
      if (held.has(id) && entry.next.length) { entry.idle = true; return; }
      const next = entry.next.shift();
      if (next) void drain(id, entry, next);
      else active.delete(id);
    }
  }
  return {
    get size() { return active.size; },
    busy: id => active.has(id),
    pending(id) { return (active.get(id)?.next || []).map(task => task.body); },
    edit(id, expected, text) {
      const body = active.get(id)?.next.find(task => task.body.pendingId === expected)?.body;
      if (!body || body.pendingId !== expected) throw new Error("This message has already started or changed.");
      body.text = text;
      return body;
    },
    cancel(id, expected) {
      const entry = active.get(id);
      if (!entry) return;
      entry.next = expected ? entry.next.filter(task => task.body.pendingId !== expected) : [];
      if (entry.idle && !entry.next.length) active.delete(id);
    },
    hold(id) { held.add(id); },
    release(id) {
      held.delete(id);
      const entry = active.get(id);
      if (!entry?.idle) return;
      entry.idle = false;
      const next = entry.next.shift();
      if (next) void drain(id, entry, next); else active.delete(id);
    },
    submit(id, run, { queue = false, front = false, onError = () => {}, body = null } = {}) {
      const entry = active.get(id);
      const task = { run, onError, body };
      if (entry) {
        if (!queue) throw new Error('A turn is already running. Use Queue next.');
        entry.next[front ? 'unshift' : 'push'](task);
      } else {
        const fresh = { next: [] };
        active.set(id, fresh);
        void drain(id, fresh, task);
      }
    },
  };
}
