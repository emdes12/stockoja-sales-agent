import type { Category } from '../discovery/catalog.js';

/** A verified fact: something a source states, with where it came from. */
export interface Fact {
  label: string;
  value: string;
  source: string; // e.g. "OpenStreetMap", "Business website", "Added by you"
  url?: string | null;
}

/** An assumption: an inference, never presented as fact. */
export interface Assumption {
  label: string;
  reason: string;
}

export interface ScoreItem {
  label: string;
  points: number;
  basis: 'fact' | 'assumption';
}

export type Fit = 'high' | 'medium' | 'low';
export interface Relevance {
  feature: 'inventory' | 'sales_tracking' | 'expenses' | 'online_store' | 'ordering';
  fit: Fit;
  why: string;
}

/** What qualification reads from a lead. */
export interface QualifyInput {
  category: Category;
  phone_key: string | null;
  email: string | null;
  website_domain: string | null;
  socials: Record<string, string>;
  address: string | null;
  branch_count: number;
  is_chain_brand: boolean;
  has_opening_hours: boolean;
  /** They filled in the interest form. */
  asked_to_hear?: boolean;
}

export interface Qualification {
  score: number;
  breakdown: ScoreItem[];
  assumptions: Assumption[];
  relevance: Relevance[];
  hasContactChannel: boolean;
}

const ONLINE_STORE_FIT: Record<Category, Fit> = {
  fashion: 'high',
  shoes_bags: 'high',
  cosmetics: 'high',
  watches_accessories: 'high',
  electronics: 'medium',
  supermarket: 'low',
};

const INVENTORY_WHY: Record<Category, string> = {
  fashion: 'Clothing stock varies by size and colour, which is hard to track by hand.',
  shoes_bags: 'Shoes come in many sizes per style; bags in many colours.',
  cosmetics: 'Many small items, often with batches and expiry dates.',
  watches_accessories: 'Small, high-value items that are easy to lose track of.',
  electronics: 'High-value stock where each missing unit hurts.',
  supermarket: 'Hundreds of products with frequent restocking.',
};

/** StockỌja features likely to matter to this kind of shop. All of this is inference from the category. */
export function relevanceFor(category: Category, branchCount: number): Relevance[] {
  return [
    { feature: 'inventory', fit: 'high', why: INVENTORY_WHY[category] },
    { feature: 'sales_tracking', fit: 'high', why: 'Daily sales recording and end-of-day totals suit any retail shop.' },
    { feature: 'expenses', fit: 'medium', why: 'Recording rent, transport and restock costs shows real profit.' },
    {
      feature: 'online_store',
      fit: ONLINE_STORE_FIT[category],
      why:
        ONLINE_STORE_FIT[category] === 'high'
          ? 'Products photograph well and are commonly sold on Instagram/WhatsApp; a storefront on the same stock fits.'
          : ONLINE_STORE_FIT[category] === 'medium'
            ? 'Gadgets sell online, but buyers often want to see them in person.'
            : 'Groceries sell online less often, though repeat orders and pickup can work.',
    },
    {
      feature: 'ordering',
      fit: category === 'supermarket' || branchCount > 1 ? 'high' : 'medium',
      why:
        branchCount > 1
          ? 'Several locations: stock transfers and orders across branches.'
          : category === 'supermarket'
            ? 'Frequent repeat orders and pickup/delivery requests.'
            : 'Orders from WhatsApp/Instagram can be tracked against stock.',
    },
  ];
}

/**
 * Rule-based score, 0–100, that you can read line by line. Fact-based points come from what a source
 * states; assumption-based points are marked as such. No AI involved.
 */
export function qualify(input: QualifyInput): Qualification {
  const breakdown: ScoreItem[] = [];
  const assumptions: Assumption[] = [];
  const add = (label: string, points: number, basis: ScoreItem['basis']) => breakdown.push({ label, points, basis });

  add('Sells in a target category', 20, 'fact');
  if (input.asked_to_hear) add('Asked us to get in touch (interest form)', 30, 'fact');
  if (input.phone_key) add('Public phone number', 10, 'fact');
  if (input.email) add('Public email address', 15, 'fact');
  if (input.website_domain) add('Has its own website', 10, 'fact');
  if (Object.keys(input.socials).length > 0) add('Public social/marketplace profile', 5, 'fact');
  if (input.address) add('Street address listed', 5, 'fact');
  if (input.has_opening_hours) add('Opening hours listed (an actively maintained listing)', 5, 'fact');

  if (input.branch_count >= 2 && input.branch_count <= 10) {
    add(`Seen at ${input.branch_count} locations`, 15, 'fact');
    assumptions.push({
      label: 'Needs stock visibility across branches',
      reason: `Listed at ${input.branch_count} locations; multi-branch shops usually struggle to see stock in one place.`,
    });
  }

  const fit = ONLINE_STORE_FIT[input.category];
  if (fit === 'high') {
    add('Products suit an online storefront', 10, 'assumption');
    assumptions.push({ label: 'Likely sells or could sell online', reason: 'Inferred from the category, not observed.' });
  } else if (input.category === 'electronics') {
    add('High-value stock benefits from tracking', 8, 'assumption');
  } else if (input.category === 'supermarket') {
    add('Large product range implies inventory effort', 5, 'assumption');
  }
  assumptions.push({
    label: 'May track stock manually or in spreadsheets',
    reason: 'Common for small Nigerian retailers; not verified for this business.',
  });

  if (input.is_chain_brand || input.branch_count > 10) {
    add('Probably a large chain with its own enterprise system', -30, 'assumption');
    assumptions.push({
      label: 'Large chain',
      reason: input.is_chain_brand
        ? 'Tagged as a national/international brand in OpenStreetMap.'
        : `Listed at ${input.branch_count} locations.`,
    });
  }

  const hasContactChannel = !!(input.phone_key || input.email || Object.keys(input.socials).length);
  let score = breakdown.reduce((s, b) => s + b.points, 0);
  if (!hasContactChannel) {
    add('No public way to contact them yet (score capped at 20)', 0, 'fact');
    score = Math.min(score, 20);
  }
  score = Math.max(0, Math.min(100, score));

  return { score, breakdown, assumptions, relevance: relevanceFor(input.category, input.branch_count), hasContactChannel };
}
