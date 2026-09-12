export function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 1 && milliseconds <= 2_147_483_647
    ? Math.trunc(milliseconds)
    : fallback;
}
