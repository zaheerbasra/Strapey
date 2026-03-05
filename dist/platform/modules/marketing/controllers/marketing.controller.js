"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketingController = void 0;
const marketing_service_1 = require("../services/marketing.service");
const service = new marketing_service_1.MarketingService();
exports.marketingController = {
    list: async (request) => {
        const { limit } = (request.query || {});
        return service.listCampaigns(Number(limit || 50));
    },
    create: async (request) => service.createCampaign(request.body)
};
