"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMarketingWorkers = registerMarketingWorkers;
const queue_1 = require("../../../core/queue");
function registerMarketingWorkers() {
    return (0, queue_1.createWorker)('marketing', async (job) => {
        if (job.name === 'marketing.campaign.execute') {
            return { ok: true, campaign_id: job.data?.campaign_id };
        }
    });
}
