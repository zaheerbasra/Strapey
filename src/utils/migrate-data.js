/**
 * Data Migration Script
 * Migrates existing data.json to new SQLite database
 */

const fs = require('fs-extra');
const path = require('path');
const prisma = require('../core/database');
const logger = require('../core/logger')('migration');

async function migrateData() {
  try {
    logger.info('Starting data migration');

    // Read existing data.json
    const dataPath = path.join(__dirname, '../../data/data.json');
    
    if (!fs.existsSync(dataPath)) {
      logger.warn('No data.json found, skipping migration');
      return;
    }

    const data = await fs.readJson(dataPath);
    const entries = Object.entries(data);

    logger.info(`Found ${entries.length} listings to migrate`);

    const results = {
      productsCreated: 0,
      listingsCreated: 0,
      errors: []
    };

    for (const [url, listing] of entries) {
      try {
        // Extract SKU (from customLabel or sku field)
        const sku = listing.sku || listing.customLabel || listing.itemNumber;
        
        if (!sku) {
          logger.warn(`Skipping listing without SKU: ${url}`);
          continue;
        }

        // Check if product already exists
        let product = await prisma.product.findUnique({
          where: { sku }
        });

        if (!product) {
          // Parse images
          const images = listing.imagesOriginal || listing.imageSourceUrls || listing.images || [];

          // Parse item specifics into category and specifics
          const specifics = listing.itemSpecifics || {};
          const brand = specifics.Brand || listing.brand || 'SHARD';
          const category = specifics.Type || listing.category || 'Knives';

          // Create product from scraped data
          product = await prisma.product.create({
            data: {
              sku: sku,
              title: listing.title,
              description: listing.description || null,
              brand: brand,
              price: parseFloat(listing.price) || 0,
              cost: null,
              inventory: listing.inventoryQuantity || 0,
              images: JSON.stringify(images),
              category: category,
              specifics: JSON.stringify(specifics),
              sourceUrl: url
            }
          });

          results.productsCreated++;
          logger.info(`Created product: ${sku}`);
        } else {
          logger.info(`Product already exists: ${sku}`);
        }

        // Create eBay listing if publishedLink exists
        if (listing.publishedLink) {
          // Check if listing already exists
          const existingListing = await prisma.listing.findFirst({
            where: {
              productId: product.id,
              channel: 'ebay',
              channelListingId: listing.listingId
            }
          });

          if (!existingListing) {
            await prisma.listing.create({
              data: {
                productId: product.id,
                channel: 'ebay',
                channelListingId: listing.listingId || null,
                title: listing.title,
                description: listing.description || null,
                price: parseFloat(listing.price) || 0,
                quantity: listing.inventoryQuantity || 0,
                status: 'active',
                listingUrl: listing.publishedLink,
                offerId: listing.offerId || null,
                metadata: JSON.stringify({
                  publishAction: listing.publishAction,
                  publishedDate: listing.publishedDate,
                  enableBackorder: listing.enableBackorder,
                  media: listing.media,
                  marketing: listing.marketing
                }),
                publishedAt: listing.publishedDate ? new Date(listing.publishedDate) : null
              }
            });

            results.listingsCreated++;
            logger.info(`Created eBay listing: ${listing.listingId}`);
          } else {
            logger.info(`Listing already exists: ${listing.listingId}`);
          }
        }

      } catch (error) {
        logger.error(`Failed to migrate listing: ${url}`, { error: error.message });
        results.errors.push({ url, error: error.message });
      }
    }

    // Log results
    logger.info('Migration completed', results);

    // Create activity log
    await prisma.activityLog.create({
      data: {
        action: 'data_migration',
        module: 'migration',
        status: 'success',
        message: 'Migrated data from data.json',
        metadata: JSON.stringify(results)
      }
    });

    console.log('\n=== Migration Results ===');
    console.log(`Products Created: ${results.productsCreated}`);
    console.log(`Listings Created: ${results.listingsCreated}`);
    console.log(`Errors: ${results.errors.length}`);
    
    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach(err => {
        console.log(`  - ${err.url}: ${err.error}`);
      });
    }

    return results;

  } catch (error) {
    logger.error('Migration failed', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateData()
    .then(() => {
      console.log('\n✅ Migration complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Migration failed:', error.message);
      process.exit(1);
    });
}

module.exports = migrateData;
