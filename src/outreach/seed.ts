import type { Db } from '../db/pool.js';
import { getState, setState } from '../settings.js';
import type { Channel } from './channels.js';

/**
 * Starting content, inserted once. Every claim comes from StockỌja's launch kit (docs/launch/LAUNCH_KIT.md):
 * only what the product does today, no invented numbers, no exclamation marks. Knowledge base entries start
 * as drafts: the agent uses none of them until you approve each one. Templates are yours to edit.
 */
const KB_SOURCE = 'StockỌja launch kit (docs/launch/LAUNCH_KIT.md)';

export const SEED_KB: Array<{ topic: string; question: string; answer: string }> = [
  {
    topic: 'Overview',
    question: 'What is StockỌja?',
    answer:
      "StockỌja is inventory management, point of sale and online store software for growing businesses, built first for Nigeria. It brings inventory, sales, POS, expenses and your online store together, so you always know what's happening in your business.",
  },
  {
    topic: 'Overview',
    question: 'Who is StockỌja for?',
    answer:
      'Product businesses in Nigeria (SMEs): shops that still run on a sales notebook, WhatsApp and a spreadsheet. It is simple enough to set up in an afternoon and strong enough for several branches and a team.',
  },
  {
    topic: 'Inventory',
    question: 'How does StockỌja handle stock?',
    answer:
      'Stock per branch, variants such as sizes and colours, reserved versus available stock, low-stock alerts, transfers between branches, and a full history of every stock change with who made it and when.',
  },
  {
    topic: 'Point of sale',
    question: 'What can the POS do?',
    answer:
      'The POS works on a laptop, tablet or phone. It supports barcodes, discounts, held sales, cash, card or transfer payments, and receipts. Stock drops automatically with each sale. Sales are voided, never deleted.',
  },
  {
    topic: 'Online store',
    question: 'Can I sell online with StockỌja?',
    answer:
      'Yes. You get your own storefront at yourname.stockoja.com on the same stock as your shop, with Paystack payments and branch pickup.',
  },
  {
    topic: 'Reports',
    question: 'Does it track expenses and reports?',
    answer: 'Yes. Sales, expenses, customers, suppliers, staff roles and reports sit together in one view.',
  },
  {
    topic: 'Staff',
    question: 'Can my staff use it without seeing everything?',
    answer: "Yes. Staff get roles, so a cashier doesn't see what the owner sees.",
  },
  {
    topic: 'Devices',
    question: 'What devices does it work on?',
    answer: "It's a web app that works on a laptop, tablet or phone.",
  },
  {
    topic: 'Pricing',
    question: 'How much does StockỌja cost?',
    answer:
      "It's free to start, with paid plans for growing businesses. I'll confirm the current prices for your business before quoting any figure.",
  },
  {
    topic: 'Getting started',
    question: 'How do I sign up?',
    answer: 'You can create a free account at the registration link I shared. Setting up takes about an afternoon.',
  },
];

const footer = `You're receiving this because {{business_name}} is publicly listed as a business. If you'd rather not hear from us, reply STOP and we won't contact you again.`;

const signature = `Kind regards,
{{sender_name}}
{{sender_title}}
stockoja.com`;

const intro = (hook: string) => `Hello {{business_name}} team,

I came across {{business_name}}{{in_city}} and wanted to introduce StockỌja. I'm {{sender_name}}.

${hook}

It works on a laptop, tablet or phone, and it's free to start: {{registration_link}}

{{booking_line}}

${signature}

${footer}`;

export const SEED_TEMPLATES: Array<{ name: string; channel: Channel; step: 'intro' | 'followup_1' | 'followup_2'; category: string | null; subject: string | null; body: string }> = [
  {
    name: 'Email intro (any category)',
    channel: 'email',
    step: 'intro',
    category: null,
    subject: 'One place for your stock, sales and online store',
    body: intro(
      'Many shops still run on a sales notebook, WhatsApp and a spreadsheet only one person understands. StockỌja brings inventory, sales, POS, expenses and your own online store together, so you always know what you have, what you sold and what you spent.',
    ),
  },
  {
    name: 'Email intro: fashion',
    channel: 'email',
    step: 'intro',
    category: 'fashion',
    subject: 'Tracking clothing stock by size and colour',
    body: intro(
      'Clothing stock is hard to track by size and colour. StockỌja keeps stock for every variant and branch, warns you when something runs low, and updates stock automatically when you sell at the counter. You also get your own online store at yourname.stockoja.com on the same stock, with Paystack payments.',
    ),
  },
  {
    name: 'Email intro: shoes and bags',
    channel: 'email',
    step: 'intro',
    category: 'shoes_bags',
    subject: 'Knowing which sizes you still have',
    body: intro(
      'Every style comes in many sizes and colours. StockỌja tracks each one as its own variant, shows what is reserved and what is available, and alerts you when a size runs low. Your online store at yourname.stockoja.com sells from the same stock, so you never promise a pair you no longer have.',
    ),
  },
  {
    name: 'Email intro: cosmetics',
    channel: 'email',
    step: 'intro',
    category: 'cosmetics',
    subject: 'Keeping track of every product on your shelves',
    body: intro(
      "With many small products, it's easy to lose track of what is in stock. StockỌja shows your stock per product and branch with low-stock alerts, gives you a POS for the counter, and an online store at yourname.stockoja.com on the same stock, with Paystack payments.",
    ),
  },
  {
    name: 'Email intro: watches and accessories',
    channel: 'email',
    step: 'intro',
    category: 'watches_accessories',
    subject: 'Seeing exactly where each item went',
    body: intro(
      'Small, high-value items are easy to lose track of. StockỌja logs every stock change with who made it and when, records each sale at the POS, and gives staff roles so a cashier only sees what they need.',
    ),
  },
  {
    name: 'Email intro: electronics',
    channel: 'email',
    step: 'intro',
    category: 'electronics',
    subject: 'Tracking high-value stock and sales',
    body: intro(
      'When each unit is expensive, every missing one hurts. StockỌja supports barcodes at the POS, logs every stock change with who made it and when, and gives staff roles so a cashier doesn\'t see what the owner sees. Sales are voided, never deleted.',
    ),
  },
  {
    name: 'Email intro: supermarkets',
    channel: 'email',
    step: 'intro',
    category: 'supermarket',
    subject: 'Stock, POS and expenses for a busy store',
    body: intro(
      'With hundreds of products, StockỌja keeps stock per branch with low-stock alerts and transfers between branches, a POS with barcodes that keeps up with a queue, and your expenses and reports in one place.',
    ),
  },
  {
    name: 'Email follow-up 1',
    channel: 'email',
    step: 'followup_1',
    category: null,
    subject: 'Re: {{previous_subject}}',
    body: `Hello {{business_name}} team,

I wrote recently about StockỌja, which brings your stock, sales, expenses and online store into one system. In case it got buried, here is the link to start free: {{registration_link}}

If now isn't the right time, that's no problem.

${signature}

${footer}`,
  },
  {
    name: 'Email follow-up 2 (last)',
    channel: 'email',
    step: 'followup_2',
    category: null,
    subject: 'Re: {{previous_subject}}',
    body: `Hello {{business_name}} team,

This is my last note about StockỌja. If tracking stock, sales and expenses in one place would help, you can start free here: {{registration_link}}

Thank you for your time.

${signature}

${footer}`,
  },
  {
    name: 'WhatsApp intro',
    channel: 'whatsapp',
    step: 'intro',
    category: null,
    subject: null,
    body: `Good day, {{business_name}}. I'm {{sender_name}} from StockỌja. We make software for {{category_label_lower}} businesses to track stock, record sales and expenses, and sell online, all in one place. It's free to start: {{registration_link}}

{{booking_line}}

If you'd rather not hear from us, reply STOP.`,
  },
];

/**
 * Direct messages you send yourself on Instagram, Facebook, TikTok, Telegram and LinkedIn. Short (Instagram and TikTok
 * cap a message at about 1,000 characters), honest, and with the same STOP line as everything else.
 */
const dm = (where: string, withBooking: boolean) => `{Hello|Hi|Good day}, {{business_name}}. {I'm|This is} {{sender_name}} from StockỌja. {I came across your page|I saw your page on ${where}} and thought this could help.

StockỌja keeps your stock, sales and expenses in one place, and gives you an online store that sells from the same stock{, so you never promise an item you've already sold|}.

{{personal_line}}

{It's free to start|You can start free}: {{registration_link}}
${withBooking ? '\n{{booking_line}}\n' : ''}
If you'd rather not hear from us, reply STOP.`;

export const SOCIAL_TEMPLATES: typeof SEED_TEMPLATES = [
  { name: 'Instagram DM intro', channel: 'instagram', step: 'intro', category: null, subject: null, body: dm('Instagram', false) },
  { name: 'Facebook message intro', channel: 'facebook', step: 'intro', category: null, subject: null, body: dm('Facebook', true) },
  { name: 'TikTok DM intro', channel: 'tiktok', step: 'intro', category: null, subject: null, body: dm('TikTok', false) },
  { name: 'Telegram message intro', channel: 'telegram', step: 'intro', category: null, subject: null, body: dm('Telegram', true) },
  { name: 'LinkedIn message intro', channel: 'linkedin', step: 'intro', category: null, subject: null, body: dm('LinkedIn', true) },
];

/** Adds the social-channel templates once, also to a database seeded before they existed (v2 added LinkedIn). */
async function seedSocialTemplates(db: Db) {
  if (await getState(db, 'seeded.social_templates.v2')) return;
  for (const t of SOCIAL_TEMPLATES) {
    await db.query(
      'INSERT INTO templates (name, channel, step, category, subject, body) SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM templates WHERE name = $1)',
      [t.name, t.channel, t.step, t.category, t.subject, t.body],
    );
  }
  await setState(db, 'seeded.social_templates.v2', { at: new Date().toISOString() });
}

/** Inserts the starting content once. Never re-inserts after you edit or retire it. */
export async function seedOutreach(db: Db) {
  await seedSocialTemplates(db);
  if (await getState(db, 'seeded.outreach')) return;
  for (const e of SEED_KB) {
    await db.query('INSERT INTO kb_entries (topic, question, answer, status, source) VALUES ($1, $2, $3, $4, $5)', [
      e.topic, e.question, e.answer, 'draft', KB_SOURCE,
    ]);
  }
  for (const t of SEED_TEMPLATES) {
    await db.query('INSERT INTO templates (name, channel, step, category, subject, body) VALUES ($1, $2, $3, $4, $5, $6)', [
      t.name, t.channel, t.step, t.category, t.subject, t.body,
    ]);
  }
  await setState(db, 'seeded.outreach', { at: new Date().toISOString() });
}

// ── Starter variants (stage 6) ────────────────────────────────────────────────
// Added only when you press "Add starter variants" under Templates, and switched off until you read and switch
// them on. They use phrase alternatives ({a|b}) and {{personal_line}}, and only claim what the templates above do.

const greet = '{Hello|Good day|Hi} {{business_name}} team,';
const close = `{If it sounds useful|If you'd like to see it}, you can start free here: {{registration_link}}

{{booking_line}}

${signature}

${footer}`;

const variant = (opening: string, hook: string) => `${greet}

${opening}

{{personal_line}}

${hook}

${close}`;

type Seed = (typeof SEED_TEMPLATES)[number];
const intros: Array<[string | null, string, string, string, string]> = [
  // [category, name suffix, subject, opening, hook]
  [null, 'B', '{A simpler way|An easier way} to {run|manage} your {shop|store}{{in_city}}',
    "I'm {{sender_name}} from StockỌja. {We help|StockỌja helps} {{category_label_lower}} businesses keep stock, sales and expenses in one place.",
    '{No more|Instead of} matching a sales notebook against what is on the shelf at the end of the day: every sale updates your stock, and you see what you sold and spent {today|at a glance}.'],
  [null, 'C', '{{business_name}}: {stock|sales} and {expenses|spending} in one {app|place}',
    "{I'm writing|A quick note} from StockỌja, where I'm {{sender_name}}.",
    'StockỌja {brings together|combines} inventory, a POS for the counter, expense records and your own online store, {so you always know|so you can see} what you have, what you sold and what you spent.'],
  ['fashion', 'B', '{Sizes and colours|Every size and colour}, {always counted|tracked for you}',
    "I'm {{sender_name}} from StockỌja. {Clothing shops|Fashion stores} tell us the hardest part is knowing which sizes and colours are left.",
    'StockỌja {tracks|counts} every size and colour as its own item, {warns you|alerts you} before something runs out, and your online store at yourname.stockoja.com sells from the same stock.'],
  ['fashion', 'C', '{Your shop and online store|Shop and online sales} on one stock count',
    "{I came across|I found} {{business_name}}{{in_city}} and {wanted to|thought I'd} introduce StockỌja.",
    'When you sell in the shop and online, it is easy to promise a dress you have already sold. StockỌja keeps one count for both, by size and colour, with Paystack payments online.'],
  ['shoes_bags', 'B', '{Which sizes are left|Sizes left in stock}, {without counting|at a glance}',
    "I'm {{sender_name}} from StockỌja.",
    '{Each|Every} style and size is tracked on its own, with what is reserved and what is available, and a {warning|low-stock alert} before a popular size runs out.'],
  ['cosmetics', 'B', '{Every product on your shelves|All your products}, {counted|tracked}',
    "I'm {{sender_name}} from StockỌja. {Cosmetics shops|Beauty stores} carry many small products, which makes stock hard to keep straight.",
    'StockỌja shows stock per product and branch, {alerts you when|warns you before} something runs low, and gives you a POS for the counter and an online store on the same stock.'],
  ['watches_accessories', 'B', '{Know where every item went|Every item accounted for}',
    "I'm {{sender_name}} from StockỌja.",
    'With small, valuable items, one missing piece hurts. StockỌja records who changed stock and when, logs each sale at the POS, and gives staff roles so a cashier only sees what they need.'],
  ['electronics', 'B', '{High-value stock|Expensive stock}, {fully tracked|properly tracked}',
    "I'm {{sender_name}} from StockỌja.",
    'StockỌja supports barcodes at the POS, logs every stock change with who made it, and never deletes a sale (it is voided with a record), so the numbers {add up|always reconcile}.'],
  ['supermarket', 'B', '{A POS that keeps up with the queue|Stock, POS and expenses for a busy store}',
    "I'm {{sender_name}} from StockỌja.",
    'For hundreds of products: stock per branch with low-stock alerts, transfers between branches, a barcode POS for busy hours, and expenses and reports in one place.'],
];

export const STARTER_VARIANTS: Seed[] = [
  ...intros.map(([category, suffix, subject, opening, hook]): Seed => ({
    name: `Email intro${category ? `: ${category.replace('_', ' ')}` : ' (any category)'} — variant ${suffix}`,
    channel: 'email', step: 'intro', category, subject, body: variant(opening, hook),
  })),
  {
    name: 'Email follow-up 1 — variant B', channel: 'email', step: 'followup_1', category: null,
    subject: 'Re: {{previous_subject}}',
    body: `${greet}

{Just checking|Following up} {in case|that} my {last|earlier} email {reached you|didn't get buried}. StockỌja keeps your stock, sales and expenses {together|in one place}, and it's free to start: {{registration_link}}

{If now isn't the right time|If it's not for you right now}, no problem at all.

${signature}

${footer}`,
  },
  {
    name: 'Email follow-up 2 (last) — variant B', channel: 'email', step: 'followup_2', category: null,
    subject: 'Re: {{previous_subject}}',
    body: `${greet}

{I won't keep writing|This is my last note}. If {keeping track of stock and sales|tracking stock, sales and expenses} in one place would help {{business_name}}, you can {start|try it} free here: {{registration_link}}

{Thank you for your time|Thanks for reading}.

${signature}

${footer}`,
  },
  {
    name: 'WhatsApp intro — variant B', channel: 'whatsapp', step: 'intro', category: null, subject: null,
    body: `{Good day|Hello}, {{business_name}}. {I'm {{sender_name}} from StockỌja|This is {{sender_name}} from StockỌja}. We help {{category_label_lower}} businesses {track stock, record sales and expenses|keep stock, sales and expenses in one place}, and sell online. {It's free to start|You can start free}: {{registration_link}}

{{booking_line}}

If you'd rather not hear from us, reply STOP.`,
  },
];
