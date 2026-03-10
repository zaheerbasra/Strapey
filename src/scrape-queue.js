// Scraping Queue System - Smart Scraping with Retry Logic
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const QUEUE_FILE = path.join(__dirname, '../data/scrape-queue.json');
const RESULTS_FILE = path.join(__dirname, '../data/scrape-results.json');

// Initialize queue storage
async function ensureQueueFile() {
  try {
    await fs.access(QUEUE_FILE);
  } catch {
    await fs.writeFile(QUEUE_FILE, JSON.stringify([], null, 2));
  }
  try {
    await fs.access(RESULTS_FILE);
  } catch {
    await fs.writeFile(RESULTS_FILE, JSON.stringify({}, null, 2));
  }
}

// Generate unique job ID
function generateJobId() {
  return crypto.randomBytes(8).toString('hex');
}

// Create a new scrape job
async function createScrapeJob(items, customLabel) {
  await ensureQueueFile();
  
  const jobId = generateJobId();
  const job = {
    id: jobId,
    status: 'pending', // pending, processing, completed, failed
    items: items.map(item => ({
      link: item.link || item.url || '',
      itemNumber: item.itemNumber || '',
      sku: item.sku || customLabel || '',
      status: 'pending',
      error: null,
      result: null,
      retries: 0,
      maxRetries: 3
    })),
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    progress: {
      total: items.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      successful: 0
    }
  };

  const queue = await getQueue();
  queue.push(job);
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
  
  return jobId;
}

// Get all jobs or specific job
async function getJob(jobId) {
  await ensureQueueFile();
  const queue = await getQueue();
  
  if (!jobId) return queue;
  
  const job = queue.find(j => j.id === jobId);
  if (!job) return null;
  
  // Include results
  const results = await getResults();
  if (results[jobId]) {
    job.results = results[jobId];
  }
  
  return job;
}

// Get queue
async function getQueue() {
  try {
    const content = await fs.readFile(QUEUE_FILE, 'utf8');
    return JSON.parse(content) || [];
  } catch {
    return [];
  }
}

// Save queue
async function saveQueue(queue) {
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

// Get results
async function getResults() {
  try {
    const content = await fs.readFile(RESULTS_FILE, 'utf8');
    return JSON.parse(content) || {};
  } catch {
    return {};
  }
}

// Save results
async function saveResults(results) {
  await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
}

// Update job status
async function updateJobStatus(jobId, status, startedAt = null) {
  const queue = await getQueue();
  const job = queue.find(j => j.id === jobId);
  
  if (job) {
    job.status = status;
    if (startedAt && !job.startedAt) {
      job.startedAt = startedAt;
    }
  }
  
  await saveQueue(queue);
}

// Update item result
async function updateItemResult(jobId, itemIndex, result, error) {
  const queue = await getQueue();
  const job = queue.find(j => j.id === jobId);
  
  if (job && job.items[itemIndex]) {
    const item = job.items[itemIndex];
    const isSkipped = typeof error === 'string' && error.toLowerCase().includes('skipped');

    if (error && isSkipped) {
      item.status = 'skipped';
      item.error = null;
      item.skipReason = error;
      item.result = result;
      job.progress.skipped = (job.progress.skipped || 0) + 1;
      job.progress.successful++;
    } else if (error) {
      item.status = 'failed';
      item.error = error;
      item.retries = (item.retries || 0) + 1;
      job.progress.failed++;
    } else {
      item.status = 'completed';
      item.result = result;
      job.progress.successful++;
    }
    job.progress.completed++;
  }
  
  // Check if job is fully processed
  if (job && job.progress.completed === job.progress.total) {
    job.status = job.progress.failed > 0 ? 'partial' : 'completed';
    job.completedAt = new Date().toISOString();
  }
  
  await saveQueue(queue);
}

// Get items needing retry (failed items with retries < maxRetries)
async function getRetryItems() {
  const queue = await getQueue();
  const retryItems = [];
  
  queue.forEach(job => {
    if (job.status !== 'completed') {
      job.items.forEach((item, index) => {
        if (item.status === 'failed' && item.retries < item.maxRetries) {
          retryItems.push({
            jobId: job.id,
            itemIndex: index,
            link: item.link,
            itemNumber: item.itemNumber,
            sku: item.sku,
            retries: item.retries,
            maxRetries: item.maxRetries
          });
        }
      });
    }
  });
  
  return retryItems;
}

// Mark job as processing
async function markAsProcessing(jobId) {
  await updateJobStatus(jobId, 'processing', new Date().toISOString());
}

// Clear old completed jobs (> 7 days)
async function cleanupOldJobs() {
  const queue = await getQueue();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const filtered = queue.filter(job => {
    return job.status !== 'completed' || new Date(job.completedAt) > new Date(sevenDaysAgo);
  });
  
  if (filtered.length !== queue.length) {
    await saveQueue(filtered);
  }
}

module.exports = {
  ensureQueueFile,
  generateJobId,
  createScrapeJob,
  getJob,
  getQueue,
  saveQueue,
  getResults,
  saveResults,
  updateJobStatus,
  updateItemResult,
  getRetryItems,
  markAsProcessing,
  cleanupOldJobs
};
