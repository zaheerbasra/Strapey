"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socialController = void 0;
const social_service_1 = require("../services/social.service");
const service = new social_service_1.SocialService();
exports.socialController = {
    list: async (request) => {
        const { limit } = (request.query || {});
        return service.list(Number(limit || 50));
    },
    create: async (request) => service.createPost(request.body)
};
