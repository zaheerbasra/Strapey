"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
const memory_1 = require("./memory");
// Re-export memory cache as redis for backward compatibility
exports.redis = memory_1.memoryCache;
