/**
 * Products Routes
 * RESTful API routes for product management
 */

const express = require('express');
const router = express.Router();
const productsController = require('./products.controller');
const productsImportService = require('./products.import.service');
const activityLogRoutes = require('./activity-log.routes');

// Product CRUD
router.get('/', productsController.list.bind(productsController));
router.get('/low-stock', productsController.lowStock.bind(productsController));

// Activity logs routes - MUST come before /:id to avoid conflicts
router.use('/', activityLogRoutes);

router.get('/sku/:sku', productsController.getBySku.bind(productsController));
router.get('/:id', productsController.getById.bind(productsController));
router.post('/', productsController.create.bind(productsController));
router.patch('/:id', productsController.update.bind(productsController));
router.delete('/:id', productsController.delete.bind(productsController));

// Inventory management
router.post('/:id/inventory', productsController.updateInventory.bind(productsController));

// eBay Product Import - must come BEFORE other POST routes
router.post('/import/bulk', async (req, res) => {
  try {
    // Get raw body as text
    let csvText = '';
    
    if (typeof req.body === 'string') {
      csvText = req.body;
    } else if (req.body && req.body.data) {
      csvText = req.body.data;
    } else {
      // If we got it as JSON, try to extract the text
      csvText = JSON.stringify(req.body);
    }

    if (!csvText || csvText.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'No data provided'
      });
    }

    // Parse the CSV data
    const products = productsImportService.parseProductData(csvText);
    
    // Import products
    const results = await productsImportService.importProducts(products, {
      updateExisting: true,
      keepScrapedData: true
    });

    res.json({
      success: true,
      message: `Import completed: ${results.created.length} created, ${results.updated.length} updated, ${results.failed.length} failed`,
      results
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/import/template', (req, res) => {
  const template = productsImportService.getImportTemplate();
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="ebay-import-template.tsv"');
  res.send(template);
});

module.exports = router;
