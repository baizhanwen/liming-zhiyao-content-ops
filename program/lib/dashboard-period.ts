/** Dashboard dates use the same Shanghai calendar as its visible heading. */
export function dashboardMonthRange(now: Date) {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  const year = local.getUTCFullYear(), month = local.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1) - offset).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1) - offset).toISOString(),
  };
}
