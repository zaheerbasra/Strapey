"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorker = exports.enqueue = exports.queues = void 0;
var memory_1 = require("./memory");
Object.defineProperty(exports, "queues", { enumerable: true, get: function () { return memory_1.queues; } });
Object.defineProperty(exports, "enqueue", { enumerable: true, get: function () { return memory_1.enqueue; } });
Object.defineProperty(exports, "createWorker", { enumerable: true, get: function () { return memory_1.createWorker; } });
