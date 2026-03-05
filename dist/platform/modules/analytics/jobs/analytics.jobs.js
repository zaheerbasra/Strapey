"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueDailyRollup = enqueueDailyRollup;
const queue_1 = require("../../../core/queue");
async function enqueueDailyRollup() {
    return (0, queue_1.enqueue)('marketing', 'analytics.daily.rollup', { at: new Date().toISOString() });
}
