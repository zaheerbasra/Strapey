"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversionRate = conversionRate;
function conversionRate(orders, visits) {
    if (!visits)
        return 0;
    return Number(((orders / visits) * 100).toFixed(2));
}
