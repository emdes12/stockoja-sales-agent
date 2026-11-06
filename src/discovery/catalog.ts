/** The merchant categories the agent targets, and how each maps to OpenStreetMap `shop=*` tags. */
export const CATEGORIES = {
  fashion: { label: 'Fashion & clothing', osmShops: ['clothes', 'fashion', 'boutique', 'fabric'] },
  shoes_bags: { label: 'Shoes & bags', osmShops: ['shoes', 'bag', 'leather'] },
  cosmetics: { label: 'Cosmetics & skincare', osmShops: ['cosmetics', 'beauty', 'perfumery', 'hairdresser_supply'] },
  watches_accessories: { label: 'Watches & accessories', osmShops: ['watches', 'jewelry', 'fashion_accessories'] },
  electronics: { label: 'Electronics & gadgets', osmShops: ['electronics', 'mobile_phone', 'computer', 'appliance', 'hifi'] },
  supermarket: { label: 'Supermarkets & groceries', osmShops: ['supermarket', 'convenience', 'grocery', 'wholesale'] },
} as const;

export type Category = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as Category[];

export function categoryForShopTag(shop: string | undefined): Category | null {
  if (!shop) return null;
  for (const id of CATEGORY_IDS) if ((CATEGORIES[id].osmShops as readonly string[]).includes(shop)) return id;
  return null;
}

/** Loose matching for CSV/manual input ("Shoes", "skincare", "gadgets"…). */
export function parseCategory(input: string | undefined): Category | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if ((CATEGORY_IDS as string[]).includes(s)) return s as Category;
  if (/fashion|cloth|boutique|wear|fabric|apparel/.test(s)) return 'fashion';
  if (/shoe|bag|footwear|leather/.test(s)) return 'shoes_bags';
  if (/cosmetic|skin|beauty|makeup|perfume|hair/.test(s)) return 'cosmetics';
  if (/watch|jewel|accessor/.test(s)) return 'watches_accessories';
  if (/electronic|gadget|phone|computer|laptop|appliance/.test(s)) return 'electronics';
  if (/supermarket|grocer|provision|mart|convenience|wholesale|food/.test(s)) return 'supermarket';
  return categoryForShopTag(s);
}

/** Nigerian states and the FCT with their ISO 3166-2 codes (used to scope OpenStreetMap queries). */
export const REGIONS = {
  'NG-LA': 'Lagos',
  'NG-FC': 'Abuja (FCT)',
  'NG-RI': 'Rivers (Port Harcourt)',
  'NG-OY': 'Oyo (Ibadan)',
  'NG-KN': 'Kano',
  'NG-OG': 'Ogun',
  'NG-ED': 'Edo (Benin City)',
  'NG-EN': 'Enugu',
  'NG-AN': 'Anambra (Onitsha)',
  'NG-KD': 'Kaduna',
  'NG-DE': 'Delta',
  'NG-AK': 'Akwa Ibom',
  'NG-CR': 'Cross River',
  'NG-OS': 'Osun',
  'NG-ON': 'Ondo',
  'NG-KW': 'Kwara',
  'NG-PL': 'Plateau',
  'NG-IM': 'Imo',
  'NG-AB': 'Abia (Aba)',
  'NG-BO': 'Borno',
  'NG-SO': 'Sokoto',
  'NG-BA': 'Bauchi',
  'NG-NI': 'Niger',
  'NG-BE': 'Benue',
  'NG-EK': 'Ekiti',
  'NG-KO': 'Kogi',
  'NG-NA': 'Nasarawa',
  'NG-EB': 'Ebonyi',
  'NG-BY': 'Bayelsa',
  'NG-AD': 'Adamawa',
  'NG-GO': 'Gombe',
  'NG-TA': 'Taraba',
  'NG-YO': 'Yobe',
  'NG-JI': 'Jigawa',
  'NG-KT': 'Katsina',
  'NG-KE': 'Kebbi',
  'NG-ZA': 'Zamfara',
} as const;

export type RegionCode = keyof typeof REGIONS;
export const REGION_CODES = Object.keys(REGIONS) as RegionCode[];

/** State name without the city hint, for storing on a lead. */
export const regionStateName = (code: RegionCode) => REGIONS[code].replace(/\s*\(.*\)$/, '');
