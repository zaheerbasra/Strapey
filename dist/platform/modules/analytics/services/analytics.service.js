"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyticsService = void 0;
const pg_1 = require("../../../core/db/pg");
class AnalyticsService {
    async dashboard() {
        const [sales] = await (0, pg_1.query)('SELECT COALESCE(SUM(total_price),0) as gross FROM orders');
        const [orders] = await (0, pg_1.query)('SELECT COUNT(*)::text as count FROM orders');
        const [products] = await (0, pg_1.query)('SELECT COUNT(*)::text as count FROM products');
        const byChannel = await (0, pg_1.query)('SELECT channel, COUNT(*) as orders, COALESCE(SUM(total_price),0) as revenue FROM orders GROUP BY channel ORDER BY revenue DESC');
        return {
            grossSales: Number(sales?.gross || 0),
            orderCount: Number(orders?.count || 0),
            productCount: Number(products?.count || 0),
            channelPerformance: byChannel
        };
    }
}
exports.AnalyticsService = AnalyticsService;
