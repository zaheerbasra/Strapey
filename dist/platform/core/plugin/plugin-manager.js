"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginManager = void 0;
class PluginManager {
    registry = new Map();
    register(plugin) {
        this.registry.set(plugin.key, plugin);
    }
    get(key) {
        return this.registry.get(key);
    }
    list() {
        return Array.from(this.registry.values()).map((p) => ({ key: p.key, channelName: p.channelName }));
    }
}
exports.pluginManager = new PluginManager();
