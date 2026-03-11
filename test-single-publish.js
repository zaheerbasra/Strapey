#!/usr/bin/env node

/**
 * Test script to publish a single SKU to eBay with detailed logging
 * Usage: node test-single-publish.js <SKU> [environment]
 * Example: node test-single-publish.js RD-BAR sandbox
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3001';
const sku = process.argv[2] || 'RD-BAR';
const environment = process.argv[3] || 'sandbox';

async function testPublish() {
  console.log('=====================================');
  console.log('SINGLE SKU PUBLISH TEST');
  console.log('=====================================');
  console.log(`SKU: ${sku}`);
  console.log(`Environment: ${environment}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log('=====================================\n');

  try {
    // Step 1: Fetch product data
    console.log(`Step 1: Fetching product data for SKU: ${sku}...`);
    const productResponse = await axios.get(`${BASE_URL}/api/products/${sku}`);
    const product = productResponse.data;
    
    console.log(`✓ Product found`);
    console.log(`  - Title: ${product.title?.substring(0, 60)}...`);
    console.log(`  - Price: $${product.price}`);
    console.log(`  - Images: ${Array.isArray(product.imageSourceUrls) ? product.imageSourceUrls.length : 0}`);
    console.log(`  - Category: ${product.categoryId || product.ebayCategoryId || 'NOT SET'}`);
    console.log(`  - Description: ${product.description ? 'YES' : 'NO'}`);
    
    if (!product.title || !product.price) {
      console.error('\n✗ Product missing required fields (title or price)');
      process.exit(1);
    }
    
    if (!Array.isArray(product.imageSourceUrls) || product.imageSourceUrls.length === 0) {
      console.error('\n✗ Product has no images');
      process.exit(1);
    }
    
    if (product.imageSourceUrls.length > 24) {
      console.warn(`\n⚠️  Warning: Product has ${product.imageSourceUrls.length} images (eBay limit is 24)`);
      console.warn(`   Only first 24 images will be used`);
    }

    // Step 2: Publish to eBay
    console.log(`\nStep 2: Publishing to eBay ${environment}...`);
    const publishEndpoint = `${BASE_URL}/api/products/${sku}/publish/${environment}`;
    console.log(`  Endpoint: ${publishEndpoint}`);
    
    const startTime = Date.now();
    const publishResponse = await axios.post(publishEndpoint, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000 // 2 minutes
    });
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    const result = publishResponse.data;
    
    console.log(`\n✓ Publish request completed in ${duration}s`);
    console.log('\n=====================================');
    console.log('PUBLISH RESULT');
    console.log('=====================================');
    console.log(`Success: ${result.success ? '✓ YES' : '✗ NO'}`);
    console.log(`Status: ${result.status || 'N/A'}`);
    console.log(`Action: ${result.action || 'N/A'}`);
    console.log(`SKU: ${result.sku || 'N/A'}`);
    console.log(`Listing ID: ${result.listingId || 'N/A'}`);
    console.log(`Offer ID: ${result.offerId || 'N/A'}`);
    console.log(`Listing Link: ${result.listingLink || 'N/A'}`);
    console.log(`Message: ${result.message || result.error || 'N/A'}`);
    
    if (result.logs && Array.isArray(result.logs)) {
      console.log(`\n--- Publish Logs (${result.logs.length} entries) ---`);
      result.logs.forEach((log) => {
        const level = log.level?.toUpperCase().padEnd(5) || 'LOG';
        const msg = log.message || JSON.stringify(log.data);
        console.log(`[${level}] ${msg}`);
      });
    }
    
    console.log('=====================================\n');
    
    if (result.success) {
      console.log('✓ PUBLISH SUCCESSFUL');
      process.exit(0);
    } else {
      console.log('✗ PUBLISH FAILED');
      console.log(`Error: ${result.error || result.message || 'Unknown error'}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n=====================================');
    console.error('ERROR');
    console.error('=====================================');
    
    if (error.response) {
      console.error(`HTTP Status: ${error.response.status}`);
      console.error(`Response:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
    }
    
    console.error('=====================================\n');
    process.exit(1);
  }
}

// Run the test
testPublish();
