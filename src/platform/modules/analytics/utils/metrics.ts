export function conversionRate(orders: number, visits: number) {
  if (!visits) return 0;
  return Number(((orders / visits) * 100).toFixed(2));
}
