"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.autoGenerateSeo = autoGenerateSeo;
function autoGenerateSeo(input) {
    const title = `${input.brand ? `${input.brand} ` : ''}${input.title}`.trim();
    const keywords = [input.brand || '', ...(input.tags || [])].filter(Boolean).slice(0, 12).join(', ');
    return {
        seo_title: title.substring(0, 80),
        meta_description: `${title}. Shop premium private-label products with fast fulfillment.`.substring(0, 160),
        keywords
    };
}
