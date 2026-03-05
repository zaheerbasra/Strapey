import { pluginManager } from '../core/plugin/plugin-manager';
import { ebayPlugin } from './ebay/plugin';
import { etsyPlugin } from './etsy/plugin';
import { wordpressPlugin } from './wordpress/plugin';
import { socialPlugin } from './social/plugin';

export function registerIntegrations() {
  pluginManager.register(ebayPlugin);
  pluginManager.register(etsyPlugin);
  pluginManager.register(wordpressPlugin);
  pluginManager.register(socialPlugin);
}
