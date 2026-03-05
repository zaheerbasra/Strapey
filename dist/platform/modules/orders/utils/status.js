"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validOrderStatuses = void 0;
exports.validOrderStatuses = new Set([
    'pending',
    'paid',
    'processing',
    'shipped',
    'delivered',
    'cancelled'
]);
