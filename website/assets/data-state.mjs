export const STALE_AFTER_MS = 60 * 60 * 1000;
export function reduceSourceState({ loading = false, feed = null, error = null, now = new Date().toISOString() } = {}) {
  if (loading) return { kind: 'loading', label: 'Loading launch record…' };
  if (error && !feed) return { kind: 'error', label: 'Launch record unavailable' };
  if (!feed) return { kind: 'error', label: 'No launch record available' };
  const states = Array.isArray(feed.sources) ? feed.sources.map((source) => source.state) : [];
  if (!states.length) return { kind: 'error', label: 'Source manifest unavailable' };
  if (states.includes('error') || states.includes('failed')) return { kind: 'error', label: 'A required source failed' };
  if (states.includes('partial')) return { kind: 'partial', label: 'Partial source coverage' };
  const ageMs = new Date(now).getTime() - new Date(feed.generatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS || states.includes('stale')) return { kind: 'stale', label: 'Last-known-good snapshot' };
  return { kind: 'complete', label: 'Current V2 refresh complete' };
}
export function publicGateMessage(enabled) {
  return enabled ? 'Ponsr launch tooling is accepting public requests.' : 'Creation of new launches through Ponsr is paused; existing records remain available.';
}
