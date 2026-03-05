export interface IntegrationPlugin {
  key: string;
  channelName: string;
  createListing?(payload: unknown): Promise<unknown>;
  updateListing?(payload: unknown): Promise<unknown>;
  pauseListing?(payload: unknown): Promise<unknown>;
  relistItem?(payload: unknown): Promise<unknown>;
  deleteListing?(payload: unknown): Promise<unknown>;
  syncOrders?(): Promise<unknown>;
  syncInventory?(payload: unknown): Promise<unknown>;
  syncPricing?(payload: unknown): Promise<unknown>;
}

class PluginManager {
  private registry = new Map<string, IntegrationPlugin>();

  register(plugin: IntegrationPlugin) {
    this.registry.set(plugin.key, plugin);
  }

  get(key: string) {
    return this.registry.get(key);
  }

  list() {
    return Array.from(this.registry.values()).map((p) => ({ key: p.key, channelName: p.channelName }));
  }
}

export const pluginManager = new PluginManager();
