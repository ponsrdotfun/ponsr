export function normaliseLaunch(raw, observedAt) {
  const blockTimestamp = typeof raw.blockTimestamp === 'string' && raw.blockTimestamp ? raw.blockTimestamp : null;
  return { ...raw, blockTimestamp, observedAt, eventTimeKnown: blockTimestamp !== null };
}
export const byEventTimeDesc = (a, b) => {
  if (!a.blockTimestamp && !b.blockTimestamp) return b.blockNumber - a.blockNumber;
  if (!a.blockTimestamp) return 1;
  if (!b.blockTimestamp) return -1;
  return b.blockTimestamp.localeCompare(a.blockTimestamp);
};
