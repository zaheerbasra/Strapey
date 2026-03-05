export type UserRole = 'admin' | 'manager' | 'marketing' | 'support' | 'viewer';

export interface Product {
  product_id: string;
  sku: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  tags: string[];
  price: number;
  cost: number;
  weight: number;
  dimensions: { length: number; width: number; height: number };
  inventory: number;
  images: string[];
  videos: string[];
  attributes: Record<string, string>;
  seo_data: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface UnifiedOrder {
  order_id: string;
  channel: string;
  channel_order_id: string;
  customer: Record<string, string>;
  items: Array<{ product_id: string; sku: string; quantity: number; unit_price: number }>;
  total_price: number;
  shipping_cost: number;
  tax: number;
  status: 'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  tracking_number?: string;
  shipping_label?: string;
  created_at: string;
}
