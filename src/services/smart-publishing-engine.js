/**
 * Smart eBay Publishing Engine
 * 
 * Intelligent publishing system with:
 * - Error detection & self-healing
 * - Retry logic with exponential backoff
 * - Rate limiting & delay management
 * - Learning system (tracks patterns over time)
 * - Critical integration monitoring
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

function isTruthyEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

class SmartPublishingEngine {
  constructor(logger) {
    this.logger = logger;
    this.statsFile = path.join(__dirname, '../../data/publish-engine-stats.json');
    this.errorPatternsFile = path.join(__dirname, '../../data/error-patterns.json');
    
    // Load or initialize stats
    this.stats = this.loadStats();
    this.errorPatterns = this.loadErrorPatterns();
    
    const fastPipeline = isTruthyEnv(process.env.FAST_PIPELINE);

    // Configuration
    this.config = {
      maxRetries: parseNonNegativeIntEnv('PUBLISH_MAX_RETRIES', fastPipeline ? 2 : 5),
      initialDelay: parseNonNegativeIntEnv('PUBLISH_INITIAL_DELAY_MS', fastPipeline ? 500 : 1000),
      maxDelay: parseNonNegativeIntEnv('PUBLISH_MAX_DELAY_MS', fastPipeline ? 10000 : 30000),
      backoffMultiplier: Number(process.env.PUBLISH_BACKOFF_MULTIPLIER) || 1.5,
      batchDelay: parseNonNegativeIntEnv('PUBLISH_BATCH_DELAY_MS', fastPipeline ? 0 : 2000),
      enableSelfHealing: true,
      enableLearning: true
    };
  }

  /**
   * Load publishing statistics
   */
  loadStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        return fs.readJsonSync(this.statsFile);
      }
    } catch (error) {
      this.logger?.warn('Failed to load stats file', { error: error.message });
    }

    return {
      totalAttempts: 0,
      successCount: 0,
      failureCount: 0,
      retryCount: 0,
      selfHealingApplied: 0,
      averageResponseTime: 0,
      lastUpdate: new Date().toISOString(),
      errorsByType: {},
      successRate: 0
    };
  }

  /**
   * Load error patterns and fixes
   */
  loadErrorPatterns() {
    try {
      if (fs.existsSync(this.errorPatternsFile)) {
        return fs.readJsonSync(this.errorPatternsFile);
      }
    } catch (error) {
      this.logger?.warn('Failed to load error patterns file', { error: error.message });
    }

    return {
      patterns: [
        {
          id: 'auth_token_invalid',
          keywords: ['invalid_grant', 'refresh token is invalid', 'access token is invalid'],
          action: 'REFRESH_TOKEN_REQUIRED',
          isRetriable: false,
          fixes: {}
        },
        {
          id: 'access_denied_permissions',
          keywords: ['access denied', 'insufficient permissions', 'errorid":1100'],
          action: 'CHECK_SELLER_PERMISSIONS',
          isRetriable: false,
          fixes: {}
        },
        {
          id: 'missing_required_field',
          keywords: ['required', 'missing', 'mandatory'],
          action: 'ADD_DEFAULT_VALUE',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'invalid_price_format',
          keywords: ['invalid price', 'price format', 'price must be numeric', 'pricingsummary'],
          action: 'NORMALIZE_PRICE',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'invalid_category',
          keywords: ['category', 'invalid', 'not found'],
          action: 'USE_DEFAULT_CATEGORY',
          isRetriable: true,
          fixes: { defaultCategory: process.env.EBAY_CATEGORY_ID }
        },
        {
          id: 'rate_limit_exceeded',
          keywords: ['rate', 'limit', '429', 'throttle'],
          action: 'INCREASE_DELAY',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'duplicate_sku',
          keywords: ['already exists', 'duplicate', 'sku'],
          action: 'UPDATE_EXISTING',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'invalid_image_url',
          keywords: ['image', 'url', 'invalid', '404'],
          action: 'VALIDATE_IMAGES',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'timeout',
          keywords: ['timeout', 'econnrefused', 'enotfound'],
          action: 'RETRY_WITH_DELAY',
          isRetriable: true,
          fixes: {}
        },
        {
          id: 'policy_id_invalid',
          keywords: ['policy', 'invalid', 'not found', 'fulfillment'],
          action: 'VALIDATE_POLICIES',
          isRetriable: true,
          fixes: {}
        }
      ],
      resolutionHistory: []
    };
  }

  /**
   * Save stats to file
   */
  saveStats() {
    try {
      this.stats.lastUpdate = new Date().toISOString();
      this.stats.successRate = this.stats.totalAttempts > 0 
        ? ((this.stats.successCount / this.stats.totalAttempts) * 100).toFixed(2)
        : 0;
      fs.writeJsonSync(this.statsFile, this.stats, { spaces: 2 });
    } catch (error) {
      this.logger?.error('Failed to save stats', { error: error.message });
    }
  }

  /**
   * Save error patterns to file
   */
  saveErrorPatterns() {
    try {
      fs.writeJsonSync(this.errorPatternsFile, this.errorPatterns, { spaces: 2 });
    } catch (error) {
      this.logger?.error('Failed to save error patterns', { error: error.message });
    }
  }

  /**
   * Analyze eBay API error response
   */
  analyzeError(error, context) {
    const analysis = {
      statusCode: error.response?.status,
      errorMessage: error.message,
      ebayErrors: error.response?.data?.errors,
      detectedIssues: [],
      recommendedFixes: [],
      pattern: null
    };

    const errorText = JSON.stringify(error.response?.data || error.message).toLowerCase();
    const oauthError = String(error.response?.data?.error || '').toLowerCase();
    const oauthDescription = String(error.response?.data?.error_description || '').toLowerCase();

    // Prioritize OAuth/token failures to avoid false positives from generic keyword matching.
    if (
      oauthError === 'invalid_grant' ||
      oauthDescription.includes('refresh token is invalid') ||
      oauthDescription.includes('issued to another client')
    ) {
      const authPattern = this.errorPatterns.patterns.find((p) => p.id === 'auth_token_invalid');
      if (authPattern) {
        analysis.pattern = authPattern;
        analysis.detectedIssues.push(authPattern.id);
        analysis.recommendedFixes.push(authPattern.action);

        const errorKey = authPattern.id;
        this.stats.errorsByType[errorKey] = (this.stats.errorsByType[errorKey] || 0) + 1;
        return analysis;
      }
    }

    // Match against error patterns
    for (const pattern of this.errorPatterns.patterns) {
      if (pattern.keywords.some(keyword => errorText.includes(keyword))) {
        analysis.pattern = pattern;
        analysis.detectedIssues.push(pattern.id);
        analysis.recommendedFixes.push(pattern.action);
        break;
      }
    }

    // Track error pattern
    const errorKey = analysis.pattern?.id || 'unknown_error';
    this.stats.errorsByType[errorKey] = (this.stats.errorsByType[errorKey] || 0) + 1;

    return analysis;
  }

  /**
   * Self-healing: Apply automatic fixes to product data
   */
  applySelfHealing(productData, analysis) {
    if (!this.config.enableSelfHealing) return productData;

    const healed = { ...productData };
    let healingApplied = false;

    for (const fix of analysis.recommendedFixes) {
      switch (fix) {
        case 'CHECK_SELLER_PERMISSIONS':
          this.logger?.warn('Self-healing blocked: Seller/API permissions issue requires account-level fix');
          break;

        case 'REFRESH_TOKEN_REQUIRED':
          // This requires manual OAuth regeneration and should not be auto-mutated.
          this.logger?.warn('Self-healing blocked: Refresh token is invalid and requires manual update');
          break;

        case 'ADD_DEFAULT_VALUE':
          if (!healed.itemSpecifics) healed.itemSpecifics = {};
          healed.itemSpecifics = {
            'Size Type': 'Large',
            'Size': 'One Size',
            'Color': 'Silver',
            ...healed.itemSpecifics
          };
          healingApplied = true;
          this.logger?.info('Self-healing: Added default item specifics');
          break;

        case 'NORMALIZE_PRICE':
          const price = parseFloat(String(healed.price).replace(/[^\d.]/g, ''));
          if (Number.isFinite(price) && price > 0) {
            healed.price = price;
            healingApplied = true;
            this.logger?.info('Self-healing: Normalized price', { price });
          }
          break;

        case 'USE_DEFAULT_CATEGORY':
          if (!healed.categoryId || healed.categoryId === 'N/A') {
            healed.categoryId = process.env.EBAY_CATEGORY_ID;
            healingApplied = true;
            this.logger?.info('Self-healing: Applied default category');
          }
          break;

        case 'VALIDATE_IMAGES':
          if (Array.isArray(healed.imageSourceUrls)) {
            healed.imageSourceUrls = healed.imageSourceUrls.filter(url => {
              try {
                new URL(url);
                return true;
              } catch {
                return false;
              }
            });
            if (healed.imageSourceUrls.length > 0) {
              healingApplied = true;
              this.logger?.info('Self-healing: Validated and filtered images');
            }
          }
          break;

        case 'VALIDATE_POLICIES':
          // Ensure policy IDs are set
          if (!healed.fulfillmentPolicyId) {
            healed.fulfillmentPolicyId = process.env.EBAY_FULFILLMENT_POLICY_ID;
          }
          if (!healed.paymentPolicyId) {
            healed.paymentPolicyId = process.env.EBAY_PAYMENT_POLICY_ID;
          }
          if (!healed.returnPolicyId) {
            healed.returnPolicyId = process.env.EBAY_RETURN_POLICY_ID;
          }
          healingApplied = true;
          this.logger?.info('Self-healing: Validated policy IDs');
          break;
      }
    }

    if (healingApplied) {
      this.stats.selfHealingApplied++;
    }

    return healed;
  }

  /**
   * Calculate delay with exponential backoff
   */
  calculateDelay(retryCount) {
    const delay = Math.min(
      this.config.initialDelay * Math.pow(this.config.backoffMultiplier, retryCount),
      this.config.maxDelay
    );
    return Math.floor(delay);
  }

  /**
   * Intelligent retry with learning
   */
  async retryWithLearning(publishFn, productData, context) {
    let lastError = null;
    let lastAnalysis = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        this.logger?.debug(`Publish attempt ${attempt + 1}/${this.config.maxRetries + 1}`, {
          sku: productData.sku,
          attempt
        });

        const result = await publishFn();
        
        this.stats.successCount++;
        this.stats.totalAttempts++;

        if (attempt > 0) {
          this.stats.retryCount++;
          this.logger?.success(`Success after ${attempt} retries`, { 
            sku: productData.sku,
            listingId: result.listingId 
          });
        }

        return {
          success: true,
          result,
          attempts: attempt + 1,
          healed: lastAnalysis?.healingApplied || false
        };

      } catch (error) {
        lastError = error;
        lastAnalysis = this.analyzeError(error, context);

        if (lastAnalysis?.pattern?.isRetriable === false) {
          this.stats.failureCount++;
          this.stats.totalAttempts++;

          this.logger?.error('Fail-fast non-retriable error detected', {
            sku: productData.sku,
            pattern: lastAnalysis.pattern.id,
            error: error.message
          });

          return {
            success: false,
            error,
            analysis: lastAnalysis,
            attempts: attempt + 1,
            healed: false
          };
        }

        this.logger?.warn(`Publish failed (attempt ${attempt + 1})`, {
          sku: productData.sku,
          error: error.message,
          statusCode: error.response?.status,
          detectedIssues: lastAnalysis.detectedIssues
        });

        // Try self-healing
        if (attempt < this.config.maxRetries && lastAnalysis.pattern) {
          this.logger?.info('Attempting self-healing...', {
            pattern: lastAnalysis.pattern.id,
            fix: lastAnalysis.recommendedFixes[0]
          });

          const healed = this.applySelfHealing(productData, lastAnalysis);
          Object.assign(productData, healed);

          // Wait before retry
          const delay = this.calculateDelay(attempt);
          this.logger?.info(`Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));

        } else if (attempt < this.config.maxRetries) {
          // No pattern detected, wait and retry anyway
          const delay = this.calculateDelay(attempt);
          this.logger?.info(`Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    this.stats.failureCount++;
    this.stats.totalAttempts++;

    this.logger?.error(`Final failure after ${this.config.maxRetries + 1} attempts`, {
      sku: productData.sku,
      lastError: lastError.message,
      analysis: lastAnalysis
    });

    return {
      success: false,
      error: lastError,
      analysis: lastAnalysis,
      attempts: this.config.maxRetries + 1,
      healed: false
    };
  }

  /**
   * Track successful pattern (learning)
   */
  trackSuccessfulPattern(metadata) {
    if (!this.config.enableLearning) return;

    try {
      this.errorPatterns.resolutionHistory.push({
        timestamp: new Date().toISOString(),
        ...metadata
      });

      // Keep last 1000 entries
      if (this.errorPatterns.resolutionHistory.length > 1000) {
        this.errorPatterns.resolutionHistory.shift();
      }

      this.saveErrorPatterns();
    } catch (error) {
      this.logger?.warn('Failed to track pattern', { error: error.message });
    }
  }

  /**
   * Get performance insights
   */
  getPerformanceInsights() {
    const totalByType = Object.values(this.stats.errorsByType).reduce((a, b) => a + b, 0);
    
    return {
      successRate: this.stats.successRate + '%',
      totalAttempts: this.stats.totalAttempts,
      successCount: this.stats.successCount,
      failureCount: this.stats.failureCount,
      retryCount: this.stats.retryCount,
      selfHealingApplied: this.stats.selfHealingApplied,
      avgRetriesPerSuccess: this.stats.successCount > 0 
        ? (this.stats.retryCount / this.stats.successCount).toFixed(2)
        : 0,
      errorsByType: this.stats.errorsByType,
      mostCommonError: Object.entries(this.stats.errorsByType).sort(
        ([, a], [, b]) => b - a
      )[0] || [null, 0],
      selfHealingRate: this.stats.totalAttempts > 0
        ? ((this.stats.selfHealingApplied / this.stats.totalAttempts) * 100).toFixed(2)
        : 0
    };
  }

  /**
   * Reset statistics (for testing)
   */
  reset() {
    this.stats = {
      totalAttempts: 0,
      successCount: 0,
      failureCount: 0,
      retryCount: 0,
      selfHealingApplied: 0,
      averageResponseTime: 0,
      lastUpdate: new Date().toISOString(),
      errorsByType: {},
      successRate: 0
    };
    this.saveStats();
  }
}

module.exports = SmartPublishingEngine;
