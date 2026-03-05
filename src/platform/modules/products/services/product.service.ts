import { randomUUID } from 'crypto';
import { query } from '../../../core/db/pg';

export class ProductService {
  async list(limit = 50) {
    return query('SELECT * FROM products ORDER BY updated_at DESC LIMIT $1', [limit]);
  }

  async getById(productId: string) {
    const rows = await query('SELECT * FROM products WHERE product_id = $1 LIMIT 1', [productId]);
    return rows[0] || null;
  }

  async create(input: any) {
    const productId = input.product_id || randomUUID();
    const rows = await query(
      `INSERT INTO products(product_id, sku, title, description, brand, category, tags, price, cost, weight, dimensions, inventory, images, videos, attributes, seo_data)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb)
       RETURNING *`,
      [
        productId,
        input.sku,
        input.title,
        input.description || '',
        input.brand || '',
        input.category || '',
        JSON.stringify(input.tags || []),
        Number(input.price || 0),
        Number(input.cost || 0),
        Number(input.weight || 0),
        JSON.stringify(input.dimensions || { length: 0, width: 0, height: 0 }),
        Number(input.inventory || 0),
        JSON.stringify(input.images || []),
        JSON.stringify(input.videos || []),
        JSON.stringify(input.attributes || {}),
        JSON.stringify(input.seo_data || {})
      ]
    );
    return rows[0];
  }

  async update(productId: string, input: any) {
    const rows = await query(
      `UPDATE products
       SET sku = COALESCE($2, sku),
           title = COALESCE($3, title),
           description = COALESCE($4, description),
           brand = COALESCE($5, brand),
           category = COALESCE($6, category),
           tags = COALESCE($7::jsonb, tags),
           price = COALESCE($8, price),
           cost = COALESCE($9, cost),
           weight = COALESCE($10, weight),
           dimensions = COALESCE($11::jsonb, dimensions),
           inventory = COALESCE($12, inventory),
           images = COALESCE($13::jsonb, images),
           videos = COALESCE($14::jsonb, videos),
           attributes = COALESCE($15::jsonb, attributes),
           seo_data = COALESCE($16::jsonb, seo_data),
           updated_at = NOW()
       WHERE product_id = $1
       RETURNING *`,
      [
        productId,
        input.sku ?? null,
        input.title ?? null,
        input.description ?? null,
        input.brand ?? null,
        input.category ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.price ?? null,
        input.cost ?? null,
        input.weight ?? null,
        input.dimensions ? JSON.stringify(input.dimensions) : null,
        input.inventory ?? null,
        input.images ? JSON.stringify(input.images) : null,
        input.videos ? JSON.stringify(input.videos) : null,
        input.attributes ? JSON.stringify(input.attributes) : null,
        input.seo_data ? JSON.stringify(input.seo_data) : null
      ]
    );
    return rows[0] || null;
  }
}
