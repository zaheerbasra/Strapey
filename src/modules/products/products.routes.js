/**
 * Products Routes
 * RESTful API routes for product management
 */

const express = require('express');
const router = express.Router();
const productsController = require('./products.controller');

// Product CRUD
router.get('/', productsController.list.bind(productsController));
router.get('/low-stock', productsController.lowStock.bind(productsController));
router.get('/sku/:sku', productsController.getBySku.bind(productsController));
router.get('/:id', productsController.getById.bind(productsController));
router.post('/', productsController.create.bind(productsController));
router.patch('/:id', productsController.update.bind(productsController));
router.delete('/:id', productsController.delete.bind(productsController));

// Inventory management
router.post('/:id/inventory', productsController.updateInventory.bind(productsController));

module.exports = router;
