/**
 * Image Deduplication Utility
 * Prevents duplicate image downloads and manages image storage efficiently
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');

/**
 * Calculate perceptual hash of an image (pHash)
 * This detects visually similar images even if they have different file sizes
 */
async function calculateImageHash(imageBuffer) {
  try {
    // Convert to grayscale, resize to 8x8, and get pixel data
    const { data, info } = await sharp(imageBuffer)
      .grayscale()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Calculate average pixel value
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const avg = sum / data.length;

    // Generate hash: 1 if pixel > average, 0 otherwise
    let hash = '';
    for (let i = 0; i < data.length; i++) {
      hash += data[i] > avg ? '1' : '0';
    }

    // Convert binary string to hex
    const hexHash = parseInt(hash, 2).toString(16).padStart(16, '0');
    return hexHash;

  } catch (error) {
    console.error('Error calculating image hash:', error.message);
    // Fallback to MD5 hash of the buffer
    return crypto.createHash('md5').update(imageBuffer).digest('hex');
  }
}

/**
 * Calculate MD5 hash of image content
 */
function calculateMD5Hash(imageBuffer) {
  return crypto.createHash('md5').update(imageBuffer).digest('hex');
}

/**
 * Find existing image by hash in the data directory
 */
async function findExistingImageByHash(hash, dataPath) {
  const imageRegistryPath = path.join(dataPath, '.image-registry.json');
  
  try {
    const registryData = await fs.readFile(imageRegistryPath, 'utf8');
    const registry = JSON.parse(registryData);
    
    if (registry[hash]) {
      // Verify the file still exists
      const imagePath = path.join(dataPath, registry[hash]);
      try {
        await fs.access(imagePath);
        return registry[hash]; // Return relative path
      } catch {
        // File doesn't exist, remove from registry
        delete registry[hash];
        await fs.writeFile(imageRegistryPath, JSON.stringify(registry, null, 2));
        return null;
      }
    }
    
    return null;
  } catch (error) {
    // Registry doesn't exist yet
    return null;
  }
}

/**
 * Register an image in the deduplication registry
 */
async function registerImage(hash, relativePath, dataPath) {
  const imageRegistryPath = path.join(dataPath, '.image-registry.json');
  
  try {
    let registry = {};
    
    try {
      const registryData = await fs.readFile(imageRegistryPath, 'utf8');
      registry = JSON.parse(registryData);
    } catch {
      // Registry doesn't exist, will create new one
    }
    
    registry[hash] = relativePath;
    await fs.writeFile(imageRegistryPath, JSON.stringify(registry, null, 2));
    
  } catch (error) {
    console.error('Error registering image:', error.message);
  }
}

/**
 * Check if an image already exists (by hash) and return its path
 */
async function findOrRegisterImage(imageBuffer, proposedPath, dataPath) {
  try {
    // Calculate both hashes
    const contentHash = calculateMD5Hash(imageBuffer);
    const perceptualHash = await calculateImageHash(imageBuffer);
    
    // Check if we already have this image (by content hash first, then perceptual)
    let existing = await findExistingImageByHash(contentHash, dataPath);
    if (existing) {
      console.log(`✓ Found duplicate by content hash, reusing: ${existing}`);
      return { path: existing, isDuplicate: true, hash: contentHash };
    }
    
    existing = await findExistingImageByHash(perceptualHash, dataPath);
    if (existing) {
      console.log(`✓ Found duplicate by perceptual hash, reusing: ${existing}`);
      return { path: existing, isDuplicate: true, hash: perceptualHash };
    }
    
    // Not a duplicate, register both hashes pointing to the new file
    const relativePath = proposedPath.replace(dataPath + '/', '');
    await registerImage(contentHash, relativePath, dataPath);
    await registerImage(perceptualHash, relativePath, dataPath);
    
    return { path: relativePath, isDuplicate: false, hash: contentHash };
    
  } catch (error) {
    console.error('Error in findOrRegisterImage:', error.message);
    // Fallback: treat as new image
    const relativePath = proposedPath.replace(dataPath + '/', '');
    return { path: relativePath, isDuplicate: false, hash: null };
  }
}

/**
 * Get all images in a product folder
 */
async function getProductImages(productHash, dataPath) {
  const productFolder = path.join(dataPath, productHash);
  
  try {
    const files = await fs.readdir(productFolder);
    const imageFiles = files.filter(f => 
      /\.(jpg|jpeg|png|webp)$/i.test(f) && !f.includes('_enhanced')
    );
    
    return imageFiles.map(f => path.join(productHash, f));
  } catch {
    return [];
  }
}

/**
 * Get enhanced images for a product
 */
async function getEnhancedImages(productHash, dataPath) {
  const productFolder = path.join(dataPath, productHash);
  
  try {
    const files = await fs.readdir(productFolder);
    const enhancedFiles = files.filter(f => 
      f.includes('_enhanced') && /\.(jpg|jpeg|png|webp)$/i.test(f)
    );
    
    return enhancedFiles.map(f => path.join(productHash, f));
  } catch {
    return [];
  }
}

/**
 * Clean up duplicate images in a product folder
 * Keeps only enhanced versions and the original if no enhanced version exists
 */
async function cleanupProductDuplicates(productHash, dataPath) {
  const productFolder = path.join(dataPath, productHash);
  let cleaned = 0;
  let savedBytes = 0;
  
  try {
    const files = await fs.readdir(productFolder);
    
    // Group images by base name
    const imageGroups = {};
    
    for (const file of files) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) continue;
      
      // Extract base name (without _enhanced suffix and extension)
      const match = file.match(/^(.+?)(_enhanced)?\.(jpg|jpeg|png|webp)$/i);
      if (!match) continue;
      
      const baseName = match[1];
      const isEnhanced = !!match[2];
      
      if (!imageGroups[baseName]) {
        imageGroups[baseName] = { original: null, enhanced: null };
      }
      
      if (isEnhanced) {
        imageGroups[baseName].enhanced = file;
      } else {
        imageGroups[baseName].original = file;
      }
    }
    
    // For each group, keep enhanced version and delete original
    for (const [baseName, group] of Object.entries(imageGroups)) {
      if (group.enhanced && group.original) {
        const originalPath = path.join(productFolder, group.original);
        const stats = await fs.stat(originalPath);
        
        await fs.unlink(originalPath);
        cleaned++;
        savedBytes += stats.size;
        
        console.log(`  Removed duplicate: ${group.original} (${(stats.size / 1024).toFixed(1)} KB)`);
      }
    }
    
  } catch (error) {
    console.error(`Error cleaning ${productHash}:`, error.message);
  }
  
  return { cleaned, savedBytes };
}

module.exports = {
  calculateImageHash,
  calculateMD5Hash,
  findExistingImageByHash,
  registerImage,
  findOrRegisterImage,
  getProductImages,
  getEnhancedImages,
  cleanupProductDuplicates
};
