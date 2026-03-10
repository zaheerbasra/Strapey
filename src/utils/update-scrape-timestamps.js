#!/usr/bin/env node

/**
 * Utility Script: Update Scrape Timestamps
 * 
 * This script updates all existing products in data.json with the current
 * timestamp for lastScrapedAt. Useful when enabling the 24-hour scrape window.
 * 
 * Usage:
 *   node src/utils/update-scrape-timestamps.js
 */

const fs = require('fs-extra');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/data.json');

async function updateScrapedTimestamps() {
  try {
    console.log('🔄 Updating scrape timestamps...\n');

    // Check if data file exists
    if (!fs.existsSync(DATA_FILE)) {
      console.error('❌ Error: data.json not found at', DATA_FILE);
      process.exit(1);
    }

    // Read existing data
    const data = fs.readJsonSync(DATA_FILE);
    
    if (typeof data !== 'object' || Array.isArray(data)) {
      console.error('❌ Error: data.json should contain an object');
      process.exit(1);
    }

    const now = new Date().toISOString();
    const keys = Object.keys(data);
    let updated = 0;
    let alreadyHasTimestamp = 0;

    console.log(`📊 Total products: ${keys.length}`);
    console.log(`⏰ Current timestamp: ${now}\n`);

    // Update products
    keys.forEach(key => {
      if (data[key] && typeof data[key] === 'object') {
        if (!data[key].lastScrapedAt) {
          data[key].lastScrapedAt = now;
          updated++;
        } else {
          alreadyHasTimestamp++;
        }
      }
    });

    // Write back to file
    fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });

    console.log('✅ Update completed:\n');
    console.log(`   ✓ Updated: ${updated} products`);
    console.log(`   ✓ Already had timestamp: ${alreadyHasTimestamp} products`);
    console.log(`   ✓ Total processed: ${keys.length}\n`);
    console.log('📝 Products with timestamps will now enforce 24-hour scrape window');

  } catch (error) {
    console.error('❌ Error updating timestamps:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  updateScrapedTimestamps();
}

module.exports = { updateScrapedTimestamps };
