export function autoGenerateSeo(input: { title: string; brand?: string; tags?: string[] }) {
  const title = `${input.brand ? `${input.brand} ` : ''}${input.title}`.trim();
  const keywords = [input.brand || '', ...(input.tags || [])].filter(Boolean).slice(0, 12).join(', ');
  return {
    seo_title: title.substring(0, 80),
    meta_description: `${title}. Shop premium private-label products with fast fulfillment.`.substring(0, 160),
    keywords
  };
}
