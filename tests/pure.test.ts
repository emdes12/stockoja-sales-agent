import { describe, expect, it } from 'vitest';
import { nameKey, phoneKey, websiteDomain, normalizeEmail, socialPlatform } from '../src/leads/normalize.js';
import { qualify, type QualifyInput } from '../src/leads/qualify.js';
import { redact, redactText } from '../src/log.js';
import { extractContacts, robotsAllows } from '../src/discovery/website.js';
import { buildOverpassQuery, elementToCandidate } from '../src/discovery/osm.js';
import { manualToCandidate, parseCsv } from '../src/discovery/csvImport.js';
import { parseCategory } from '../src/discovery/catalog.js';

describe('normalisation', () => {
  it('reduces business names to a comparable key', () => {
    expect(nameKey('Mama Ngozi Fashion Ventures Ltd.')).toBe('mama ngozi fashion');
    expect(nameKey('ÀDÉ Stores & Sons')).toBe(nameKey('Ade Stores'));
  });

  it('normalises Nigerian phone numbers', () => {
    expect(phoneKey('0803 123 4567')).toBe('2348031234567');
    expect(phoneKey('+234 803 123 4567')).toBe('2348031234567');
    expect(phoneKey('+234 (0) 803-123-4567')).toBe('2348031234567');
    expect(phoneKey('8031234567')).toBe('2348031234567');
    expect(phoneKey('+2348031234567; +2348039999999')).toBe('2348031234567');
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey('+44 20 7946 0958')).toBeNull();
  });

  it('separates own websites from social profiles', () => {
    expect(websiteDomain('https://www.shopmama.ng/about')).toBe('shopmama.ng');
    expect(websiteDomain('instagram.com/mamashop')).toBeNull();
    expect(socialPlatform('https://m.facebook.com/mama')).toBe('facebook');
    expect(socialPlatform('https://wa.me/2348031234567')).toBe('whatsapp');
  });

  it('validates emails', () => {
    expect(normalizeEmail(' Info@Shop.NG ')).toBe('info@shop.ng');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('maps loose category names', () => {
    expect(parseCategory('Skincare')).toBe('cosmetics');
    expect(parseCategory('gadgets')).toBe('electronics');
    expect(parseCategory('shoe and bag')).toBe('shoes_bags');
    expect(parseCategory('provisions')).toBe('supermarket');
    expect(parseCategory('furniture')).toBeNull();
  });
});

describe('qualification', () => {
  const base: QualifyInput = {
    category: 'fashion', phone_key: null, email: null, website_domain: null, socials: {}, address: null,
    branch_count: 1, is_chain_brand: false, has_opening_hours: false,
  };

  it('scores contactable shops higher and labels every point as fact or assumption', () => {
    const q = qualify({ ...base, phone_key: '2348031234567', email: 'a@b.ng', website_domain: 'b.ng' });
    expect(q.score).toBe(20 + 10 + 15 + 10 + 10);
    expect(q.breakdown.every((b) => b.basis === 'fact' || b.basis === 'assumption')).toBe(true);
    expect(q.hasContactChannel).toBe(true);
  });

  it('caps leads with no contact channel at 20', () => {
    const q = qualify({ ...base, address: '1 Broad St', has_opening_hours: true });
    expect(q.hasContactChannel).toBe(false);
    expect(q.score).toBeLessThanOrEqual(20);
  });

  it('penalises recognised chains and rewards small multi-branch shops', () => {
    const chain = qualify({ ...base, category: 'supermarket', phone_key: '2348031234567', is_chain_brand: true });
    const small = qualify({ ...base, category: 'supermarket', phone_key: '2348031234567', branch_count: 3 });
    expect(chain.score).toBeLessThan(small.score);
    expect(small.breakdown.some((b) => b.label.includes('3 locations'))).toBe(true);
  });

  it('describes feature fit per category', () => {
    const fashion = qualify(base).relevance.find((r) => r.feature === 'online_store');
    const grocery = qualify({ ...base, category: 'supermarket' }).relevance.find((r) => r.feature === 'online_store');
    expect(fashion?.fit).toBe('high');
    expect(grocery?.fit).toBe('low');
  });
});

describe('log redaction', () => {
  it('removes secrets and masks contact details but keeps dates and ids', () => {
    const text = redactText('key re_AbCdEfGh12345678ijkl and AIzaSyA1234567890abcdefghij, mail john.doe@shop.ng, call 0803 123 4567 on 2026-10-26 id 123456789');
    expect(text).not.toContain('re_AbCdEfGh12345678ijkl');
    expect(text).not.toContain('AIzaSy');
    expect(text).toContain('j***@shop.ng');
    expect(text).not.toContain('123 4567');
    expect(text).toContain('2026-10-26');
    expect(text).toContain('123456789');
    expect(redactText('postgres://sales_agent:hunter2@localhost:5432/db')).toBe('postgres://sales_agent:***@localhost:5432/db');
  });

  it('redacts secret-looking keys in objects', () => {
    expect(redact({ apiKey: 'x', nested: { password: 'y', ok: 'fine' } })).toEqual({ apiKey: '[redacted]', nested: { password: '[redacted]', ok: 'fine' } });
  });
});

describe('website contact extraction', () => {
  it('honours robots.txt', () => {
    const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: BadBot\nDisallow: /';
    expect(robotsAllows(robots, '/')).toBe(true);
    expect(robotsAllows(robots, '/private/x')).toBe(false);
    expect(robotsAllows(robots, '/private/contact')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /', '/')).toBe(false);
    expect(robotsAllows('', '/anything')).toBe(true);
  });

  it('prefers an email on the shop domain and finds profiles, ignoring share links and images', () => {
    const html = `
      <a href="mailto:owner@gmail.com">x</a> sales&#64;mamashop.ng
      <img src="logo@2x.png"> <a href="https://www.instagram.com/mamashop/">IG</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="https://wa.me/2348031234567">chat</a> <a href="/contact-us">Contact</a>`;
    const found = extractContacts(html, 'https://mamashop.ng/');
    expect(found.emails[0]).toBe('sales@mamashop.ng');
    expect(found.emails).not.toContain('logo@2x.png');
    expect(found.socials.instagram).toBe('https://www.instagram.com/mamashop/');
    expect(found.socials.facebook).toBeUndefined();
    expect(found.socials.whatsapp).toContain('wa.me');
    expect(found.contactPath).toBe('/contact-us');
  });
});

describe('OpenStreetMap mapping', () => {
  it('builds a state-scoped query for the category tags', () => {
    const q = buildOverpassQuery('shoes_bags', 'NG-LA');
    expect(q).toContain('"ISO3166-2"="NG-LA"');
    expect(q).toContain('^(shoes|bag|leather)$');
  });

  it('keeps business details, moves social "websites", ignores personal tags and unnamed shops', () => {
    const c = elementToCandidate(
      {
        type: 'node', id: 42, lat: 6.5, lon: 3.4,
        tags: { shop: 'clothes', name: 'Ada Styles', phone: '0803 123 4567', website: 'https://instagram.com/adastyles', 'contact:person': 'Ada Obi', 'addr:street': 'Allen Avenue', 'addr:city': 'Ikeja', opening_hours: 'Mo-Sa 09:00-19:00' },
      },
      'NG-LA',
    )!;
    expect(c.business_name).toBe('Ada Styles');
    expect(c.category).toBe('fashion');
    expect(c.state).toBe('Lagos');
    expect(c.website).toBeNull();
    expect(c.socials?.instagram).toContain('instagram.com');
    expect(JSON.stringify(c)).not.toContain('Ada Obi');
    expect(c.facts.every((f) => f.source === 'OpenStreetMap' && f.url === 'https://www.openstreetmap.org/node/42')).toBe(true);
    expect(elementToCandidate({ type: 'node', id: 1, tags: { shop: 'clothes' } }, 'NG-LA')).toBeNull();
    expect(elementToCandidate({ type: 'node', id: 2, tags: { shop: 'bakery', name: 'Bread' } }, 'NG-LA')).toBeNull();
  });
});

describe('CSV import', () => {
  it('parses headers loosely and records rows as user-provided', () => {
    const { rows, error } = parseCsv('﻿Business Name,Category,Phone,Instagram\nKemi Beauty,Skincare,08031234567,https://instagram.com/kemi\n');
    expect(error).toBeUndefined();
    const c = manualToCandidate(rows[0]!, 'csv');
    expect('error' in c).toBe(false);
    if ('error' in c) return;
    expect(c.category).toBe('cosmetics');
    expect(c.facts.every((f) => f.source === 'Imported by you (CSV)')).toBe(true);
  });

  it('rejects rows without a usable category and files without business_name', () => {
    expect(manualToCandidate({ business_name: 'X', category: 'furniture' }, 'csv')).toEqual({ error: 'Unknown category "furniture"' });
    expect(parseCsv('name,category\nA,fashion').error).toMatch(/business_name/);
  });
});
