/**
 * Image Cleaner Utility
 * Removes free shipping banners, promotional overlays, and advertisements from scraped images
 */

const sharp = require('sharp');
const fs = require('fs').promises;

/**
 * Detect and remove common promotional overlays from product images
 * Common patterns:
 * - "FREE SHIPPING" banners (usually top 10-15% or bottom 10-15%)
 * - "20% OFF" badges (usually corners or top portion)
 * - "SALE" overlays
 * - Promotional text banners
 * 
 * @param {Buffer|string} inputImage - Input image buffer or file path
 * @param {Object} options - Cleaning options
 * @returns {Promise<Buffer>} - Cleaned image buffer
 */
async function removePromotionalOverlays(inputImage, options = {}) {
  const {
    removeTopBanner = true,     // Remove top 12% if it looks like a banner
    removeBottomBanner = true,  // Remove bottom 12% if it looks like a banner
    cropThreshold = 0.15,       // Maximum portion to crop (15%)
    detectTextBanners = true     // Analyze for text-heavy regions
  } = options;

  try {
    // Load input image
    let imageBuffer;
    if (typeof inputImage === 'string') {
      imageBuffer = await fs.readFile(inputImage);
    } else {
      imageBuffer = inputImage;
    }

    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    // Detect if image has promotional overlays by analyzing edge regions
    const bannerAnalysis = await analyzeForBanners(imageBuffer, metadata);
    
    let cropAmount = {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0
    };

    // Remove top banner if detected
    if (removeTopBanner && bannerAnalysis.hasTopBanner) {
      cropAmount.top = Math.min(
        Math.floor(height * bannerAnalysis.topBannerHeight),
        Math.floor(height * cropThreshold)
      );
      console.log(`Detected top banner, cropping ${cropAmount.top}px (${((cropAmount.top/height)*100).toFixed(1)}%)`);
    }

    // Remove bottom banner if detected
    if (removeBottomBanner && bannerAnalysis.hasBottomBanner) {
      cropAmount.bottom = Math.min(
        Math.floor(height * bannerAnalysis.bottomBannerHeight),
        Math.floor(height * cropThreshold)
      );
      console.log(`Detected bottom banner, cropping ${cropAmount.bottom}px (${((cropAmount.bottom/height)*100).toFixed(1)}%)`);
    }

    // Only crop if we detected something
    if (cropAmount.top > 0 || cropAmount.bottom > 0 || cropAmount.left > 0 || cropAmount.right > 0) {
      const newWidth = width - cropAmount.left - cropAmount.right;
      const newHeight = height - cropAmount.top - cropAmount.bottom;

      const cleanedBuffer = await image
        .extract({
          left: cropAmount.left,
          top: cropAmount.top,
          width: newWidth,
          height: newHeight
        })
        .toBuffer();

      console.log(`Image cleaned: ${width}x${height} → ${newWidth}x${newHeight}`);
      return cleanedBuffer;
    }

    // No promotional content detected, return original
    return imageBuffer;

  } catch (error) {
    console.error('Error cleaning image:', error.message);
    // Return original image if cleaning fails
    if (typeof inputImage === 'string') {
      return await fs.readFile(inputImage);
    }
    return inputImage;
  }
}

/**
 * Analyze image for promotional banner regions
 * Looks for:
 * - Solid color bars (common for "FREE SHIPPING" banners)
 * - High contrast regions at edges
 * - Unusual aspect ratios suggesting overlays
 */
async function analyzeForBanners(imageBuffer, metadata) {
  const { width, height } = metadata;
  
  const analysis = {
    hasTopBanner: false,
    topBannerHeight: 0,
    hasBottomBanner: false,
    bottomBannerHeight: 0
  };

  try {
    // Extract top 15% strip for analysis
    const topStripHeight = Math.floor(height * 0.15);
    const topStrip = await sharp(imageBuffer)
      .extract({ left: 0, top: 0, width, height: topStripHeight })
      .stats();

    // Extract bottom 15% strip for analysis
    const bottomStripHeight = Math.floor(height * 0.15);
    const bottomStripTop = height - bottomStripHeight;
    const bottomStrip = await sharp(imageBuffer)
      .extract({ left: 0, top: bottomStripTop, width, height: bottomStripHeight })
      .stats();

    // Check if top strip has characteristics of a banner:
    // - Low standard deviation (solid color regions)
    // - Extreme brightness or darkness
    const topStdDev = topStrip.channels.reduce((sum, ch) => sum + ch.stdev, 0) / topStrip.channels.length;
    const topMean = topStrip.channels.reduce((sum, ch) => sum + ch.mean, 0) / topStrip.channels.length;
    
    if (topStdDev < 40 && (topMean < 50 || topMean > 200)) {
      analysis.hasTopBanner = true;
      analysis.topBannerHeight = 0.12; // Default to 12% crop
    }

    // Check bottom strip
    const bottomStdDev = bottomStrip.channels.reduce((sum, ch) => sum + ch.stdev, 0) / bottomStrip.channels.length;
    const bottomMean = bottomStrip.channels.reduce((sum, ch) => sum + ch.mean, 0) / bottomStrip.channels.length;
    
    if (bottomStdDev < 40 && (bottomMean < 50 || bottomMean > 200)) {
      analysis.hasBottomBanner = true;
      analysis.bottomBannerHeight = 0.12; // Default to 12% crop
    }

  } catch (error) {
    console.error('Banner analysis error:', error.message);
  }

  return analysis;
}

/**
 * Remove corner badges and overlays (FREE SHIPPING, SALE badges, etc.)
 * Detects circular/rectangular badges commonly placed in corners
 */
async function removeCornerBadges(inputImage, options = {}) {
  const {
    cornerSize = 0.20,    // Size of corner to check (20% of dimensions)
    detectRed = true,      // Detect red badges (common for FREE SHIPPING)
    detectGreen = true,    // Detect green badges
    detectYellow = true,   // Detect yellow badges  
    saturationThreshold = 30,  // Minimum saturation for badge detection
    brightnessThreshold = 50   // Minimum brightness difference
  } = options;

  try {
    let imageBuffer;
    if (typeof inputImage === 'string') {
      imageBuffer = await fs.readFile(inputImage);
    } else {
      imageBuffer = inputImage;
    }

    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    // Define corner regions to check
    const cornerWidth = Math.floor(width * cornerSize);
    const cornerHeight = Math.floor(height * cornerSize);
    
    const corners = [
      { name: 'top-right', left: width - cornerWidth, top: 0, width: cornerWidth, height: cornerHeight },
      { name: 'top-left', left: 0, top: 0, width: cornerWidth, height: cornerHeight },
      { name: 'bottom-right', left: width - cornerWidth, top: height - cornerHeight, width: cornerWidth, height: cornerHeight },
      { name: 'bottom-left', left: 0, top: height - cornerHeight, width: cornerWidth, height: cornerHeight }
    ];

    let badgesDetected = [];

    // Check each corner for badges
    for (const corner of corners) {
      try {
        const cornerBuffer = await sharp(imageBuffer)
          .extract({ left: corner.left, top: corner.top, width: corner.width, height: corner.height })
          .raw()
          .toBuffer({ resolveWithObject: true });

        const hasBadge = analyzeCornerForBadge(cornerBuffer.data, cornerBuffer.info, {
          detectRed,
          detectGreen,
          detectYellow,
          saturationThreshold,
          brightnessThreshold
        });

        if (hasBadge.detected) {
          badgesDetected.push({ ...corner, ...hasBadge });
          console.log(`✓ Detected ${hasBadge.color} badge in ${corner.name} corner`);
        }
      } catch (err) {
        // Corner extraction failed, skip
      }
    }

    // If badges detected, inpaint/blur those regions
    if (badgesDetected.length > 0) {
      console.log(`Removing ${badgesDetected.length} corner badge(s)...`);
      return await removeBadgeRegions(imageBuffer, badgesDetected, metadata);
    }

    return imageBuffer;

  } catch (error) {
    console.error('Error removing corner badges:', error.message);
    if (typeof inputImage === 'string') {
      return await fs.readFile(inputImage);
    }
    return inputImage;
  }
}

/**
 * Analyze a corner region for badge characteristics
 */
function analyzeCornerForBadge(pixelData, info, options) {
  const { width, height, channels } = info;
  const { detectRed, detectGreen, detectYellow, saturationThreshold, brightnessThreshold } = options;
  
  let redPixels = 0;
  let greenPixels = 0;
  let yellowPixels = 0;
  let totalPixels = width * height;
  let highSaturationPixels = 0;

  // Analyze pixel colors
  for (let i = 0; i < pixelData.length; i += channels) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];

    // Calculate saturation
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : ((max - min) / max) * 100;

    if (saturation > saturationThreshold) {
      highSaturationPixels++;

      // Detect red (FREE SHIPPING badges are often red)
      if (detectRed && r > g + brightnessThreshold && r > b + brightnessThreshold && r > 150) {
        redPixels++;
      }

      // Detect green
      if (detectGreen && g > r + brightnessThreshold && g > b + brightnessThreshold && g > 150) {
        greenPixels++;
      }

      // Detect yellow/orange
      if (detectYellow && r > 150 && g > 100 && b < 100 && Math.abs(r - g) < 100) {
        yellowPixels++;
      }
    }
  }

  const redPercent = (redPixels / totalPixels) * 100;
  const greenPercent = (greenPixels / totalPixels) * 100;
  const yellowPercent = (yellowPixels / totalPixels) * 100;
  const saturationPercent = (highSaturationPixels / totalPixels) * 100;

  // Badge detection thresholds
  const BADGE_THRESHOLD = 15; // 15% of corner region

  if (redPercent > BADGE_THRESHOLD) {
    return { detected: true, color: 'red', coverage: redPercent };
  }
  if (greenPercent > BADGE_THRESHOLD) {
    return { detected: true, color: 'green', coverage: greenPercent };
  }
  if (yellowPercent > BADGE_THRESHOLD) {
    return { detected: true, color: 'yellow', coverage: yellowPercent };
  }

  // Also detect high saturation regions (generic colorful badges)
  if (saturationPercent > 25) {
    return { detected: true, color: 'colorful', coverage: saturationPercent };
  }

  return { detected: false };
}

/**
 * Remove badge regions by blurring them heavily or replacing with neutral content
 */
async function removeBadgeRegions(imageBuffer, badges, metadata) {
  const { width, height } = metadata;

  // Create a composite with blurred badge regions
  let processedImage = sharp(imageBuffer);

  const composites = [];

  for (const badge of badges) {
    try {
      // Extract and heavily blur the badge region
      const blurredRegion = await sharp(imageBuffer)
        .extract({ left: badge.left, top: badge.top, width: badge.width, height: badge.height })
        .blur(50) // Heavy blur
        .modulate({ brightness: 0.9, saturation: 0.3 }) // Desaturate
        .toBuffer();

      composites.push({
        input: blurredRegion,
        left: badge.left,
        top: badge.top
      });
    } catch (err) {
      console.error(`Failed to blur badge region:`, err.message);
    }
  }

  if (composites.length > 0) {
    const result = await processedImage
      .composite(composites)
      .toBuffer();
    
    return result;
  }

  return imageBuffer;
}

/**
 * Remove watermarks from corners (legacy function, now calls removeCornerBadges)
 */
async function removeCornerWatermarks(inputImage, options = {}) {
  return removeCornerBadges(inputImage, options);
}

/**
 * Clean product image: remove promotional content and ads
 * This is the main entry point for image cleaning
 */
async function cleanProductImage(inputImage, options = {}) {
  try {
    // Step 1: Remove promotional overlays (FREE SHIPPING, SALE banners, etc.)
    let cleanedBuffer = await removePromotionalOverlays(inputImage, options);

    // Step 2: Remove corner badges (FREE SHIPPING badges, SALE badges, etc.)
    // This is now enabled by default
    cleanedBuffer = await removeCornerBadges(cleanedBuffer, {
      cornerSize: options.cornerSize || 0.20,
      detectRed: options.detectRed !== false,
      detectGreen: options.detectGreen !== false,
      detectYellow: options.detectYellow !== false,
      ...options
    });

    return cleanedBuffer;

  } catch (error) {
    console.error('Error in cleanProductImage:', error);
    // Return original on error
    if (typeof inputImage === 'string') {
      return await fs.readFile(inputImage);
    }
    return inputImage;
  }
}

module.exports = {
  cleanProductImage,
  removePromotionalOverlays,
  removeCornerBadges,
  removeCornerWatermarks,
  analyzeForBanners
};
