"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGraphql = registerGraphql;
const pg_1 = require("../db/pg");
const schema = `
  type Product {
    product_id: ID!
    sku: String!
    title: String!
    brand: String
    category: String
    price: Float
    inventory: Int
  }

  type UnifiedOrder {
    order_id: ID!
    channel: String!
    channel_order_id: String!
    status: String!
    total_price: Float!
    created_at: String!
  }

  type Query {
    products(limit: Int = 20): [Product!]!
    orders(limit: Int = 20): [UnifiedOrder!]!
  }
`;
const resolvers = {
    Query: {
        products: async (_, args) => (0, pg_1.query)('SELECT product_id, sku, title, brand, category, price, inventory FROM products ORDER BY updated_at DESC LIMIT $1', [args.limit || 20]),
        orders: async (_, args) => (0, pg_1.query)('SELECT order_id, channel, channel_order_id, status, total_price, created_at FROM orders ORDER BY created_at DESC LIMIT $1', [args.limit || 20])
    }
};
async function registerGraphql(app) {
    await app.register(require('mercurius'), {
        schema,
        resolvers,
        graphiql: true,
        path: '/graphql'
    });
}
