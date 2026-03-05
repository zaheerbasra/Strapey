/**
 * Listings Routes
 * RESTful API routes for listing management
 */

const express = require('express');
const router = express.Router();
const listingsController = require('./listings.controller');

// Listing CRUD
router.get('/', listingsController.list.bind(listingsController));
router.get('/active', listingsController.getActive.bind(listingsController));
router.get('/product/:productId', listingsController.getByProduct.bind(listingsController));
router.get('/:id', listingsController.getById.bind(listingsController));
router.post('/', listingsController.create.bind(listingsController));
router.patch('/:id', listingsController.update.bind(listingsController));
router.delete('/:id', listingsController.delete.bind(listingsController));

// Listing actions
router.post('/:id/status', listingsController.updateStatus.bind(listingsController));
router.post('/:id/sync-quantity', listingsController.syncQuantity.bind(listingsController));

module.exports = router;
