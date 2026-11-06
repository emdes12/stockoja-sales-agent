import { parse, type HTMLElement, type Node } from 'node-html-parser';

/**
 * Turns a web page into readable text that keeps its structure: headings become "## Heading" lines (so the
 * chunker can follow them), list items "- item", table rows "a | b". Menus, footers, forms and scripts are
 * dropped. Links are collected from the whole page (menus included) so a site can be followed.
 */
export function htmlToText(html: string, pageUrl?: string): { title: string | null; text: string; links: string[] } {
  const root = parse(html, { comment: false });
  root.querySelectorAll('script, style, noscript, template, svg, iframe, canvas').forEach((e) => e.remove());

  const links: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')?.trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith('#')) continue;
    try {
      links.push(pageUrl ? new URL(href, pageUrl).toString() : href);
    } catch {
      /* ignore malformed links */
    }
  }

  const title =
    clean(root.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '') ||
    clean(root.querySelector('title')?.text ?? '') ||
    clean(root.querySelector('h1')?.text ?? '') ||
    null;
  const description = clean(root.querySelector('meta[name="description"]')?.getAttribute('content') ?? '');

  root.querySelectorAll('nav, footer, form, aside, [role="navigation"], [aria-hidden="true"], [hidden], button, select').forEach((e) => e.remove());
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = clean(buf);
    buf = '';
    if (t && t !== '-' && out[out.length - 1] !== t) out.push(t);
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      buf += node.text;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? '';
    const h = tag.match(/^h([1-6])$/);
    if (h) {
      flush();
      const t = clean(el.text);
      if (t) out.push(`${'#'.repeat(Number(h[1]))} ${t}`);
      return;
    }
    if (tag === 'br') {
      buf += ' ';
      return;
    }
    if (tag === 'li') {
      flush();
      buf = '- ';
      el.childNodes.forEach(walk);
      flush();
      return;
    }
    if (tag === 'tr') {
      flush();
      const cells = el.querySelectorAll('th, td').map((c) => clean(c.text)).filter(Boolean);
      if (cells.length) out.push(cells.join(' | '));
      return;
    }
    if (BLOCK.has(tag)) {
      flush();
      el.childNodes.forEach(walk);
      flush();
      return;
    }
    el.childNodes.forEach(walk);
  };
  walk(main);
  flush();

  const body = out.join('\n\n');
  const text = description && !body.includes(description) ? `${description}\n\n${body}` : body;
  return { title, text, links };
}

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'body', 'blockquote', 'pre', 'ul', 'ol', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'figure', 'figcaption', 'details', 'summary', 'address', 'hr',
]);

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
