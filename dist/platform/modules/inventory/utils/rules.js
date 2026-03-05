"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldPauseListing = shouldPauseListing;
function shouldPauseListing(inventory) {
    return inventory < 5;
}
