#!/usr/bin/env node
/**
 * Image Deduplication and Cleanup Script
 * Removes duplicate images and keeps only enhanced versions
 */

const fs = require('fs').promises;
const path = require('path');
const { cleanupProductDuplicates } = require('./src/utils/image-deduplication');

const DATA_PATH = path.join(__dirname, 'data');

async function cleanupAllProductImages() {
  console.log('🧹 Image Cleanup & Deduplication');
  console.log('=================================\n');
  
  let totalCleaned = 0;
  let totalSavedBytes = 0;
  let foldersProcessed = 0;
  
  try {
    // Get all product folders (MD5 hash directories)
    const entries = await fs.readdir(DATA_PATH);
    const productFolders = [];
    
    for (const entry of entries) {
      const entryPath = path.join(DATA_PATH, entry);
      const stats = await fs.stat(entryPath);
      
      if (stats.isDirectory() && /^[a-f0-9]{32}$/.test(entry)) {
        productFolders.push(entry);
      }
    }
    
    console.log(`Found ${productFolders.length} product folders\n`);
    
    // Process each folder
    for (const folder of productFolders) {
      process.stdout.write(`Processing ${folder}... `);
      
      const result = await cleanupProductDuplicates(folder, DATA_PATH);
      
      if (result.cleaned > 0) {
        console.log(`✓ Removed ${result.cleaned} duplicate(s), saved ${(result.savedBytes / 1024).toFixed(1)} KB`);
        totalCleaned += result.cleaned;
        totalSavedBytes += result.savedBytes;
      } else {
        console.log('✓ No duplicates');
      }
      
      foldersProcessed++;
    }
    
    console.log('\n=================================');
    console.log('📊 Cleanup Summary:');
    console.log(`  Folders processed: ${foldersProcessed}`);
    console.log(`  Duplicates removed: ${totalCleaned}`);
    console.log(`  Storage saved: ${(totalSavedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log('=================================\n');
    
    if (totalCleaned > 0) {
      console.log('✅ Cleanup complete! Your storage has been optimized.');
    } else {
      console.log('✅ No duplicates found. Your storage is already optimized!');
    }
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

// Additional cleanup: Remove orphaned folders (no data.json product reference)
async function findOrphanedFolders() {
  console.log('\n🔍 Checking for orphaned image folders...\n');
  
  try {
    // Load products database
    const dataJsonPath = path.join(DATA_PATH, 'data.json');
    const productsData = JSON.parse(await fs.readFile(dataJsonPath, 'utf8'));
    
    // Collect all image folder hashes referenced by products
    const referencedFolders = new Set();
    
    for (const product of Object.values(productsData)) {
      if (Array.isArray(product.imagesOriginal)) {
        product.imagesOriginal.forEach(imgPath => {
          const folder = imgPath.split('/')[0];
          if (/^[a-f0-9]{32}$/.test(folder)) {
            referencedFolders.add(folder);
          }
        });
      }
      
      if (Array.isArray(product.images)) {
        product.images.forEach(imgPath => {
          const folder = imgPath.split('/')[0];
          if (/^[a-f0-9]{32}$/.test(folder)) {
            referencedFolders.add(folder);
          }
        });
      }
    }
    
    console.log(`${referencedFolders.size} folders are referenced by products`);
    
    // Check all folders in data directory
    const entries = await fs.readdir(DATA_PATH);
    const orphaned = [];
    
    for (const entry of entries) {
      const entryPath = path.join(DATA_PATH, entry);
      const stats = await fs.stat(entryPath);
      
      if (stats.isDirectory() && /^[a-f0-9]{32}$/.test(entry)) {
        if (!referencedFolders.has(entry)) {
          orphaned.push(entry);
        }
      }
    }
    
    if (orphaned.length > 0) {
      console.log(`\n⚠️  Found ${orphaned.length} orphaned folder(s):\n`);
      
      let totalOrphanedSize = 0;
      
      for (const folder of orphaned) {
        const folderPath = path.join(DATA_PATH, folder);
        const size = await getFolderSize(folderPath);
        totalOrphanedSize += size;
        
        console.log(`  ${folder} (${(size / 1024 / 1024).toFixed(2)} MB)`);
      }
      
      console.log(`\n  Total orphaned storage: ${(totalOrphanedSize / 1024 / 1024).toFixed(2)} MB`);
      console.log('\n💡 To remove these orphaned folders, run:');
      console.log('   node cleanup-images.js --remove-orphaned');
      
    } else {
      console.log('✅ No orphaned folders found!');
    }
    
  } catch (error) {
    console.error('Error checking for orphaned folders:', error.message);
  }
}

async function getFolderSize(folderPath) {
  let size = 0;
  
  try {
    const files = await fs.readdir(folderPath);
    
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const stats = await fs.stat(filePath);
      
      if (stats.isFile()) {
        size += stats.size;
      }
    }
  } catch {
    // Ignore errors
  }
  
  return size;
}

async function removeOrphanedFolders() {
  console.log('\n🗑️  Removing orphaned folders...\n');
  
  try {
    // Load products database
    const dataJsonPath = path.join(DATA_PATH, 'data.json');
    const productsData = JSON.parse(await fs.readFile(dataJsonPath, 'utf8'));
    
    // Collect all image folder hashes referenced by products
    const referencedFolders = new Set();
    
    for (const product of Object.values(productsData)) {
      if (Array.isArray(product.imagesOriginal)) {
        product.imagesOriginal.forEach(imgPath => {
          const folder = imgPath.split('/')[0];
          if (/^[a-f0-9]{32}$/.test(folder)) {
            referencedFolders.add(folder);
          }
        });
      }
      
      if (Array.isArray(product.images)) {
        product.images.forEach(imgPath => {
          const folder = imgPath.split('/')[0];
          if (/^[a-f0-9]{32}$/.test(folder)) {
            referencedFolders.add(folder);
          }
        });
      }
    }
    
    // Check all folders in data directory
    const entries = await fs.readdir(DATA_PATH);
    let removed = 0;
    let savedBytes = 0;
    
    for (const entry of entries) {
      const entryPath = path.join(DATA_PATH, entry);
      const stats = await fs.stat(entryPath);
      
      if (stats.isDirectory() && /^[a-f0-9]{32}$/.test(entry)) {
        if (!referencedFolders.has(entry)) {
          const size = await getFolderSize(entryPath);
          await fs.rm(entryPath, { recursive: true });
          removed++;
          savedBytes += size;
          console.log(`  Removed: ${entry} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        }
      }
    }
    
    console.log(`\n✅ Removed ${removed} orphaned folder(s)`);
    console.log(`   Storage saved: ${(savedBytes / 1024 / 1024).toFixed(2)} MB`);
    
  } catch (error) {
    console.error('Error removing orphaned folders:', error);
    process.exit(1);
  }
}

// Main execution
(async () => {
  const args = process.argv.slice(2);
  
  if (args.includes('--remove-orphaned')) {
    await removeOrphanedFolders();
  } else if (args.includes('--check-orphaned')) {
    await findOrphanedFolders();
  } else {
    // Default: clean duplicates
    await cleanupAllProductImages();
    
    // Also check for orphaned folders
    await findOrphanedFolders();
  }
})();
