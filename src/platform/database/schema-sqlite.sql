-- SQLite Schema for Strapey Platform
-- Converted from PostgreSQL schema

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  weight DECIMAL(12,3) NOT NULL DEFAULT 0,
  dimensions TEXT NOT NULL DEFAULT '{"length":0,"width":0,"height":0}',
  inventory INTEGER NOT NULL DEFAULT 0,
  images TEXT NOT NULL DEFAULT '[]',
  videos TEXT NOT NULL DEFAULT '[]',
  attributes TEXT NOT NULL DEFAULT '{}',
  seo_data TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_listings (
  listing_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, external_listing_id)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_order_id TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '{}',
  items TEXT NOT NULL DEFAULT '[]',
  total_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  tracking_number TEXT,
  shipping_label TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, channel_order_id)
);

CREATE TABLE IF NOT EXISTS shipping_labels (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  label_url TEXT NOT NULL,
  tracking_number TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  campaign_id TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  discount_type TEXT NOT NULL,
  discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  schedule_at DATETIME,
  status TEXT NOT NULL DEFAULT 'scheduled',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_posts (
  post_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  product_id TEXT REFERENCES products(product_id) ON DELETE SET NULL,
  caption TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  scheduled_time DATETIME,
  status TEXT NOT NULL DEFAULT 'draft',
  engagement_metrics TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS integration_secrets (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(integration_key, secret_name)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_orders_channel_status ON orders(channel, status);
CREATE INDEX IF NOT EXISTS idx_listings_channel_product ON channel_listings(channel, product_id);
