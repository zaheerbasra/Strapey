import { query } from '../../../core/db/pg';

export class InventoryService {
  async listLowStock(threshold = 5) {
    return query('SELECT product_id, sku, title, inventory FROM products WHERE inventory < $1 ORDER BY inventory ASC', [threshold]);
  }

  async adjust(productId: string, delta: number) {
    const rows = await query(
      'UPDATE products SET inventory = GREATEST(0, inventory + $2), updated_at = NOW() WHERE product_id = $1 RETURNING product_id, sku, inventory',
      [productId, delta]
    );
    return rows[0] || null;
  }
}
