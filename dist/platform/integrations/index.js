"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIntegrations = registerIntegrations;
const plugin_manager_1 = require("../core/plugin/plugin-manager");
const plugin_1 = require("./ebay/plugin");
const plugin_2 = require("./etsy/plugin");
const plugin_3 = require("./wordpress/plugin");
const plugin_4 = require("./social/plugin");
function registerIntegrations() {
    plugin_manager_1.pluginManager.register(plugin_1.ebayPlugin);
    plugin_manager_1.pluginManager.register(plugin_2.etsyPlugin);
    plugin_manager_1.pluginManager.register(plugin_3.wordpressPlugin);
    plugin_manager_1.pluginManager.register(plugin_4.socialPlugin);
}
