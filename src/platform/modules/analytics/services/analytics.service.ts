import { query } from '../../../core/db/pg';

export class AnalyticsService {
  async dashboard() {
    const [sales] = await query<{ gross: string }>('SELECT COALESCE(SUM(total_price),0) as gross FROM orders');
    const [orders] = await query<{ count: string }>('SELECT COUNT(*)::text as count FROM orders');
    const [products] = await query<{ count: string }>('SELECT COUNT(*)::text as count FROM products');
    const byChannel = await query('SELECT channel, COUNT(*) as orders, COALESCE(SUM(total_price),0) as revenue FROM orders GROUP BY channel ORDER BY revenue DESC');

    return {
      grossSales: Number(sales?.gross || 0),
      orderCount: Number(orders?.count || 0),
      productCount: Number(products?.count || 0),
      channelPerformance: byChannel
    };
  }
}
