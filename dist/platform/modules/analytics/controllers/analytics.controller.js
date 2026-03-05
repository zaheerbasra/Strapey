"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsController = void 0;
const analytics_service_1 = require("../services/analytics.service");
const service = new analytics_service_1.AnalyticsService();
exports.analyticsController = {
    dashboard: async () => service.dashboard()
};
