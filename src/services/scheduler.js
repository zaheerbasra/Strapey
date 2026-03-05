/**
 * Simple Job Scheduler
 * Uses node-cron for background task scheduling
 */

const cron = require('node-cron');
const logger = require('../core/logger')('scheduler');

class Scheduler {
  constructor() {
    this.jobs = [];
  }

  /**
   * Schedule a recurring job
   * @param {string} name - Job name
   * @param {string} schedule - Cron expression (e.g., '*/5 * * * *' for every 5 minutes)
   * @param {Function} task - Function to execute
   */
  scheduleJob(name, schedule, task) {
    try {
      const job = cron.schedule(schedule, async () => {
        logger.info(`Running scheduled job: ${name}`);
        try {
          await task();
          logger.info(`Job completed: ${name}`);
        } catch (error) {
          logger.error(`Job failed: ${name}`, { error: error.message });
        }
      });

      this.jobs.push({ name, schedule, job });
      logger.info(`Scheduled job: ${name}`, { schedule });
      
      return job;
    } catch (error) {
      logger.error(`Failed to schedule job: ${name}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Stop a job
   */
  stopJob(name) {
    const jobIndex = this.jobs.findIndex(j => j.name === name);
    if (jobIndex !== -1) {
      this.jobs[jobIndex].job.stop();
      this.jobs.splice(jobIndex, 1);
      logger.info(`Stopped job: ${name}`);
    }
  }

  /**
   * Stop all jobs
   */
  stopAll() {
    this.jobs.forEach(job => {
      job.job.stop();
    });
    this.jobs = [];
    logger.info('Stopped all scheduled jobs');
  }

  /**
   * Get all scheduled jobs
   */
  listJobs() {
    return this.jobs.map(job => ({
      name: job.name,
      schedule: job.schedule
    }));
  }
}

// Singleton instance
const scheduler = new Scheduler();

// Example: Schedule order sync job (runs every 10 minutes)
// scheduler.scheduleJob('order-sync', '*/10 * * * *', async () => {
//   // Import orders from eBay
//   const ebayIntegration = require('../integrations/ebay');
//   await ebayIntegration.syncOrders();
// });

// Example: Schedule inventory sync (runs every hour)
// scheduler.scheduleJob('inventory-sync', '0 * * * *', async () => {
//   // Sync inventory across channels
//   const listingsService = require('../modules/listings/listings.service');
//   const activeListings = await listingsService.getActiveListings();
//   for (const listing of activeListings) {
//     await listingsService.syncQuantity(listing.id);
//   }
// });

// Graceful shutdown
process.on('SIGTERM', () => {
  scheduler.stopAll();
});

process.on('SIGINT', () => {
  scheduler.stopAll();
});

module.exports = scheduler;
