/**
 * Image Watermarking Utility for SHARD BLADE
 * Adds branded watermark to product images
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

const brandConfig = require('../brand/brand-config.json');

/**
 * Add SHARD BLADE watermark to image
 * 
 * @param {Buffer|string} inputImage - Input image buffer or file path
 * @param {Object} options - Watermark options
 * @returns {Promise<Buffer>} - Watermarked image buffer
 */
async function addWatermark(inputImage, options = {}) {
  const {
    position = 'bottom-right', // top-left, top-right, bottom-left, bottom-right, center
    opacity = 0.6,
    text = brandConfig.name || 'Strapey',
    subtext = brandConfig.tagline || 'Crafted for the Wild',
    fontSize = 24,
    color = '#ffffff', // White text
    backgroundColor = 'rgba(0, 0, 0, 0.75)', // Semi-transparent black
    padding = 15
  } = options;

  try {
    // Load input image
    let imageBuffer;
    if (typeof inputImage === 'string') {
      imageBuffer = await fs.readFile(inputImage);
    } else {
      imageBuffer = inputImage;
    }

    // Get image metadata
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    // Calculate watermark dimensions
    const watermarkWidth = Math.min(width * 0.25, 250);
    const watermarkHeight = 70;
    const textFontSize = Math.floor(fontSize * (watermarkWidth / 250));
    const subtextFontSize = Math.floor(textFontSize * 0.45);

    // Create SVG watermark
    const svgWatermark = createWatermarkSVG({
      width: watermarkWidth,
      height: watermarkHeight,
      text,
      subtext,
      textFontSize,
      subtextFontSize,
      color,
      backgroundColor,
      opacity
    });

    // Calculate position
    const positions = {
      'top-left': { left: padding, top: padding },
      'top-right': { left: width - watermarkWidth - padding, top: padding },
      'bottom-left': { left: padding, top: height - watermarkHeight - padding },
      'bottom-right': { left: width - watermarkWidth - padding, top: height - watermarkHeight - padding },
      'center': { left: Math.floor((width - watermarkWidth) / 2), top: Math.floor((height - watermarkHeight) / 2) }
    };

    const pos = positions[position] || positions['bottom-right'];

    // Composite watermark onto image
    const watermarkedBuffer = await image
      .composite([{
        input: Buffer.from(svgWatermark),
        top: pos.top,
        left: pos.left
      }])
      .toBuffer();

    return watermarkedBuffer;
  } catch (error) {
    console.error('Error adding watermark:', error);
    // Return original image if watermarking fails
    if (typeof inputImage === 'string') {
      return await fs.readFile(inputImage);
    }
    return inputImage;
  }
}

/**
 * Create SVG watermark content
 */
function createWatermarkSVG(options) {
  const {
    width,
    height,
    text,
    subtext,
    textFontSize,
    subtextFontSize,
    color,
    backgroundColor,
    opacity
  } = options;

  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="${width}" height="${height}" fill="${backgroundColor}" rx="5"/>
      
      <!-- Shield Icon -->
      <g transform="translate(10, ${height / 2 - 12})">
        <polygon points="0,0 6,-4 12,0 12,16 6,22 0,16" 
                 fill="none" 
                 stroke="${color}" 
                 stroke-width="1.5" 
                 opacity="${opacity}"/>
        <line x1="6" y1="-3" x2="6" y2="20" 
              stroke="${color}" 
              stroke-width="1.5" 
              opacity="${opacity}"/>
      </g>
      
      <!-- Brand Text -->
      <text x="30" y="${height / 2 - 2}" 
            font-family="Arial, sans-serif" 
            font-size="${textFontSize}" 
            font-weight="900" 
            fill="${color}" 
            opacity="${opacity}"
            letter-spacing="1">${text}</text>
      
      <!-- Tagline -->
      <text x="30" y="${height / 2 + subtextFontSize + 2}" 
            font-family="Arial, sans-serif" 
            font-size="${subtextFontSize}" 
            font-weight="400" 
            fill="${color}" 
            opacity="${opacity * 0.85}"
            letter-spacing="0.5"
            style="text-transform: uppercase;">${subtext}</text>
    </svg>
  `;
}

/**
 * Add watermark to multiple images
 */
async function addWatermarkBatch(imagePaths, options = {}) {
  const results = [];
  
  for (const imagePath of imagePaths) {
    try {
      const watermarkedBuffer = await addWatermark(imagePath, options);
      const outputPath = options.outputDir 
        ? path.join(options.outputDir, path.basename(imagePath))
        : imagePath.replace(/(\.[^.]+)$/, '_watermarked$1');
      
      await fs.writeFile(outputPath, watermarkedBuffer);
      results.push({ success: true, input: imagePath, output: outputPath });
    } catch (error) {
      results.push({ success: false, input: imagePath, error: error.message });
    }
  }
  
  return results;
}

/**
 * Check if watermarking is enabled in brand config
 */
function isWatermarkingEnabled() {
  return brandConfig.watermark?.enabled !== false;
}

/**
 * Get watermark settings from brand config
 */
function getWatermarkSettings() {
  return {
    enabled: brandConfig.watermark?.enabled !== false,
    text: brandConfig.watermark?.text || brandConfig.name || 'Strapey',
    subtext: brandConfig.watermark?.subtext || brandConfig.tagline || 'Crafted for the Wild',
    position: brandConfig.watermark?.position || 'bottom-right',
    opacity: brandConfig.watermark?.opacity || 0.6,
    fontSize: brandConfig.watermark?.fontSize || 24
  };
}

module.exports = {
  addWatermark,
  addWatermarkBatch,
  isWatermarkingEnabled,
  getWatermarkSettings
};
