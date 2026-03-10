"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.pgPool = exports.closeDb = exports.getDb = exports.executeRaw = exports.query = void 0;
// Import SQLite as the database backend
var sqlite_1 = require("./sqlite");
Object.defineProperty(exports, "query", { enumerable: true, get: function () { return sqlite_1.query; } });
Object.defineProperty(exports, "executeRaw", { enumerable: true, get: function () { return sqlite_1.exec; } });
Object.defineProperty(exports, "getDb", { enumerable: true, get: function () { return sqlite_1.getDb; } });
Object.defineProperty(exports, "closeDb", { enumerable: true, get: function () { return sqlite_1.closeDb; } });
// Legacy interface compatibility
exports.pgPool = {
    query: async (text, params = []) => {
        const results = await Promise.resolve().then(() => __importStar(require('./sqlite'))).then(m => m.query(text, params));
        return { rows: results };
    }
};
