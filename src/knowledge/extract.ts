import { parse as parseCsv } from 'csv-parse/sync';
import { htmlToText } from './html.js';

/** A refusal about knowledge input, with a reason you can act on. */
export class KnowledgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv'] as const;
/** Upload size limit. A long PDF manual is usually well under this. */
export const MAX_UPLOAD_BYTES = 20_000_000;
/** Extracted text limit (about 500 pages). */
const MAX_TEXT_CHARS = 3_000_000;

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

/**
 * Reads the text out of an uploaded file. PDF (text-based; scanned images have no text to read), Word (.docx),
 * plain text, Markdown, HTML and CSV. Everything runs locally.
 */
export async function extractText(name: string, data: Buffer): Promise<{ text: string; title: string; mime: string }> {
  const ext = extOf(name);
  const title = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || name;
  let text: string;
  let mime: string;
  switch (ext) {
    case 'txt':
    case 'md':
    case 'markdown':
      text = data.toString('utf8');
      mime = ext === 'txt' ? 'text/plain' : 'text/markdown';
      break;
    case 'html':
    case 'htm':
      text = htmlToText(data.toString('utf8')).text;
      mime = 'text/html';
      break;
    case 'csv': {
      // Each row becomes "Column: value; Column: value", so a price list or FAQ sheet stays readable.
      const rows = parseCsv(data, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as Record<string, string>[];
      text = rows
        .map((r) => Object.entries(r).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join('; '))
        .filter(Boolean)
        .join('\n\n');
      mime = 'text/csv';
      break;
    }
    case 'pdf': {
      const { getDocumentProxy, extractText: pdfText } = await import('unpdf');
      try {
        const pdf = await getDocumentProxy(new Uint8Array(data));
        const { text: pages } = await pdfText(pdf, { mergePages: false });
        text = (pages as string[]).join('\n\n');
      } catch (err) {
        throw new KnowledgeError('UNREADABLE', `Could not read this PDF: ${(err as Error).message}`);
      }
      mime = 'application/pdf';
      break;
    }
    case 'docx': {
      const mammoth = (await import('mammoth')).default;
      try {
        // Through HTML so headings and lists survive.
        const { value } = await mammoth.convertToHtml({ buffer: data });
        text = htmlToText(value).text;
      } catch (err) {
        throw new KnowledgeError('UNREADABLE', `Could not read this Word file: ${(err as Error).message}`);
      }
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      break;
    }
    case 'doc':
      throw new KnowledgeError('UNSUPPORTED', 'Old .doc files are not supported. Save it as .docx or PDF and upload that.');
    default:
      throw new KnowledgeError('UNSUPPORTED', `"${name}" is not a supported file. Use ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`);
  }
  text = text.replace(/\u0000/g, '');
  if (text.length > MAX_TEXT_CHARS) throw new KnowledgeError('TOO_LARGE', 'This document has too much text (over 3 million characters). Split it into parts.');
  if (!text.trim()) {
    throw new KnowledgeError(
      'NO_TEXT',
      ext === 'pdf' ? 'No text found in this PDF. It may be scanned images; export it with text (or OCR it) first.' : 'No text found in this file.',
    );
  }
  return { text, title, mime };
}
