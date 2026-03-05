"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryService = void 0;
const pg_1 = require("../../../core/db/pg");
class InventoryService {
    async listLowStock(threshold = 5) {
        return (0, pg_1.query)('SELECT product_id, sku, title, inventory FROM products WHERE inventory < $1 ORDER BY inventory ASC', [threshold]);
    }
    async adjust(productId, delta) {
        const rows = await (0, pg_1.query)('UPDATE products SET inventory = GREATEST(0, inventory + $2), updated_at = NOW() WHERE product_id = $1 RETURNING product_id, sku, inventory', [productId, delta]);
        return rows[0] || null;
    }
}
exports.InventoryService = InventoryService;
