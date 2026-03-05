/**
 * Orders Routes
 */

const express = require('express');
const router = express.Router();
const ordersController = require('./orders.controller');

router.get('/', ordersController.list.bind(ordersController));
router.get('/new', ordersController.getNew.bind(ordersController));
router.get('/:id', ordersController.getById.bind(ordersController));
router.post('/', ordersController.create.bind(ordersController));
router.post('/:id/status', ordersController.updateStatus.bind(ordersController));

module.exports = router;
