const PRODUCT_GROUPS = Object.freeze({
  PISTOL_GRIPS: 'pistol-parts',
  HUNTING_KNIVES: 'hunting-knives',
  KITCHEN_CHEF_SETS: 'kitchen-chef-sets',
  OTHER: 'other'
});

const PRODUCT_GROUP_LABELS = Object.freeze({
  [PRODUCT_GROUPS.PISTOL_GRIPS]: 'Pistol Parts',
  [PRODUCT_GROUPS.HUNTING_KNIVES]: 'Hunting Knives',
  [PRODUCT_GROUPS.KITCHEN_CHEF_SETS]: 'Kitchen/Chef Sets',
  [PRODUCT_GROUPS.OTHER]: 'Other'
});

const GROUP_KEYWORD_RULES = [
  {
    group: PRODUCT_GROUPS.PISTOL_GRIPS,
    keywords: [
      'pistol grip',
      'pistol grips',
      '1911 grip',
      '1911 grips',
      'handgun grip',
      'handgun grips',
      'revolver grip',
      'revolver grips',
      'gun grip',
      'gun grips'
    ]
  },
  {
    group: PRODUCT_GROUPS.KITCHEN_CHEF_SETS,
    keywords: [
      'kitchen knife',
      'kitchen knives',
      'chef knife',
      'chef knives',
      'chef set',
      'kitchen set',
      'cutlery set',
      'knife set',
      'butcher set',
      'paring knife',
      'cleaver',
      'santoku'
    ]
  },
  {
    group: PRODUCT_GROUPS.HUNTING_KNIVES,
    keywords: [
      'hunting knife',
      'hunting knives',
      'fixed blade',
      'bowie',
      'skinner',
      'survival knife',
      'damascus',
      'pocket knife',
      'folding knife',
      'outdoor knife'
    ]
  }
];

function normalizeProductGroup(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';

  if (
    normalized === 'pistol-parts' ||
    normalized === 'pistol_parts' ||
    normalized === 'pistol parts' ||
    normalized === 'pistol-grips' ||
    normalized === 'pistol_grips' ||
    normalized === 'pistol grips' ||
    normalized === 'gun-grips' ||
    normalized === 'gun grips'
  ) {
    return PRODUCT_GROUPS.PISTOL_GRIPS;
  }

  if (
    normalized === 'hunting-knives' ||
    normalized === 'hunting_knives' ||
    normalized === 'hunting knives'
  ) {
    return PRODUCT_GROUPS.HUNTING_KNIVES;
  }

  if (
    normalized === 'kitchen-chef-sets' ||
    normalized === 'kitchen_chef_sets' ||
    normalized === 'kitchen chef sets' ||
    normalized === 'kitchen-chef' ||
    normalized === 'chef sets' ||
    normalized === 'kitchen sets'
  ) {
    return PRODUCT_GROUPS.KITCHEN_CHEF_SETS;
  }

  if (normalized === 'other') {
    return PRODUCT_GROUPS.OTHER;
  }

  return '';
}

function getProductGroupLabel(group) {
  const normalized = normalizeProductGroup(group) || PRODUCT_GROUPS.OTHER;
  return PRODUCT_GROUP_LABELS[normalized] || PRODUCT_GROUP_LABELS[PRODUCT_GROUPS.OTHER];
}

function buildClassificationText(product) {
  const itemSpecificsValues = product && typeof product.itemSpecifics === 'object'
    ? Object.values(product.itemSpecifics)
    : [];

  return [
    product?.title,
    product?.description,
    product?.ebayCategory,
    product?.category,
    product?.customLabel,
    product?.sku,
    ...itemSpecificsValues
  ]
    .map((part) => String(part || '').toLowerCase())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectProductGroup(product) {
  const explicit = normalizeProductGroup(product?.productGroup);
  if (explicit) {
    return explicit;
  }

  const text = buildClassificationText(product);
  if (!text) {
    return PRODUCT_GROUPS.OTHER;
  }

  for (const rule of GROUP_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return rule.group;
    }
  }

  return PRODUCT_GROUPS.OTHER;
}

function applyProductGroup(product) {
  const next = { ...(product || {}) };
  next.productGroup = detectProductGroup(next);
  next.productGroupLabel = getProductGroupLabel(next.productGroup);
  return next;
}

function isPistolGripGroup(productOrGroup) {
  if (typeof productOrGroup === 'string') {
    return normalizeProductGroup(productOrGroup) === PRODUCT_GROUPS.PISTOL_GRIPS;
  }
  return detectProductGroup(productOrGroup) === PRODUCT_GROUPS.PISTOL_GRIPS;
}

module.exports = {
  PRODUCT_GROUPS,
  PRODUCT_GROUP_LABELS,
  normalizeProductGroup,
  getProductGroupLabel,
  detectProductGroup,
  applyProductGroup,
  isPistolGripGroup
};
