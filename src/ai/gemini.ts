import { env } from '../config.js';
import { OutreachError } from '../outreach/messages.js';

export interface GenerateRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Ask for a JSON object back. */
  json?: boolean;
  /** Which model; default GEMINI_MODEL. */
  model?: string;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  finishReason: string | null;
}

export const aiConfigured = () => !!env.GEMINI_API_KEY;

/** A failed call, with whether another try (or another model) may succeed. */
export class AiCallError extends OutreachError {
  constructor(code: string, message: string, readonly kind: 'busy' | 'quota' | 'missing' | 'refused') {
    super(code, message);
  }
}

/** One call to the Gemini API. The key goes in a header, never in the URL or the logs. */
async function geminiGenerate(req: GenerateRequest): Promise<GenerateResult> {
  const model = req.model ?? env.GEMINI_MODEL;
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens, temperature: 0.4 };
  if (req.json) generationConfig.responseMimeType = 'application/json';
  // 2.5 Flash "thinks" by default, billed as output; short sales emails don't need it.
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let res: Response;
  try {
    res = await fetch(`${env.GEMINI_API_URL}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AiCallError('AI_UNAVAILABLE', `Could not reach Gemini (${model}): ${(err as Error).message}`, 'busy');
  }
  const data = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    error?: { message?: string };
  } | null;
  const why = data?.error?.message ? `: ${data.error.message.slice(0, 300)}` : '';
  if (res.status === 429) throw new AiCallError('AI_RATE_LIMITED', `Gemini ${model}: too many requests (free-tier or quota limit)${why}`, 'quota');
  if (res.status >= 500) throw new AiCallError('AI_UNAVAILABLE', `Gemini ${model} is busy or down (HTTP ${res.status})${why}`, 'busy');
  if (res.status === 404) throw new AiCallError('AI_MODEL_MISSING', `Gemini has no model "${model}" for this key${why}`, 'missing');
  if (!res.ok) throw new AiCallError('AI_FAILED', `Gemini refused the request (HTTP ${res.status})${why}`, 'refused');
  const cand = data?.candidates?.[0];
  const u = data?.usageMetadata ?? {};
  return {
    text: (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim(),
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    model,
    finishReason: cand?.finishReason ?? null,
  };
}

/** The text models this key can use (names only), for picking backups automatically. Free to call. */
async function geminiListModels(): Promise<string[]> {
  const res = await fetch(`${env.GEMINI_API_URL}/v1beta/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> } | null;
  return (data?.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}

/** Replaceable in tests, so no test ever calls (or pays for) the real API, or waits. */
export const aiDeps: {
  generate: (req: GenerateRequest) => Promise<GenerateResult>;
  listModels: () => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
} = { generate: geminiGenerate, listModels: geminiListModels, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// ── Busy models: retry, then switch to a backup model automatically ──────────

/** Waits before retrying the same model when it is busy (HTTP 5xx or no answer). */
const RETRY_WAITS_MS = [2_000, 6_000];
/** A model that kept failing is skipped for this long, so every draft doesn't pay for the same retries. */
const COOL_DOWN_MS = 10 * 60_000;
const coolingUntil = new Map<string, number>();
let discovered: { at: number; models: string[] } | null = null;

/** Stable Flash models, newest first, Flash before Flash-Lite ("gemini-3.8-flash", "gemini-3.8-flash-lite"…). */
export function pickBackups(available: string[], primary: string, max = 3): string[] {
  const rx = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;
  return available
    .filter((m) => rx.test(m) && m !== primary)
    .sort((a, b) => {
      const [, va, la] = rx.exec(a)!;
      const [, vb, lb] = rx.exec(b)!;
      return Number(vb) - Number(va) || Number(!!la) - Number(!!lb);
    })
    .slice(0, max);
}

/** The models to try, in order: GEMINI_MODEL, then GEMINI_FALLBACK_MODELS, or (when that is empty) ones found for your key. */
export async function modelChain(): Promise<{ models: string[]; source: 'env' | 'auto' }> {
  const fromEnv = env.GEMINI_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return { models: [env.GEMINI_MODEL, ...fromEnv.filter((m) => m !== env.GEMINI_MODEL)], source: 'env' };
  if (!discovered || Date.now() - discovered.at > 24 * 3600_000) {
    discovered = { at: Date.now(), models: await aiDeps.listModels().catch(() => []) };
  }
  return { models: [env.GEMINI_MODEL, ...pickBackups(discovered.models, env.GEMINI_MODEL)], source: 'auto' };
}

/** For tests: forget busy models and discovered names. */
export function resetModelState() {
  coolingUntil.clear();
  discovered = null;
}

/**
 * One generation that survives a busy Gemini: the same model is retried twice with growing waits when it is busy
 * (HTTP 5xx, no answer); a model that is out of quota or doesn't exist is skipped at once; then the next model in the
 * chain is tried. A model that failed is rested for 10 minutes. Only a refusal about the request itself stops at once.
 */
export async function generateResilient(req: GenerateRequest): Promise<GenerateResult> {
  const { models } = await modelChain();
  const now = Date.now();
  const ready = models.filter((m) => (coolingUntil.get(m) ?? 0) <= now);
  const order = ready.length ? ready : models;
  const failures: string[] = [];
  for (const model of order) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await aiDeps.generate({ ...req, model });
        coolingUntil.delete(model);
        return r;
      } catch (err) {
        if (!(err instanceof AiCallError) || err.kind === 'refused') throw err;
        if (err.kind === 'busy' && attempt < RETRY_WAITS_MS.length) {
          await aiDeps.sleep(RETRY_WAITS_MS[attempt]!);
          continue;
        }
        failures.push(err.message);
        coolingUntil.set(model, Date.now() + COOL_DOWN_MS);
        break;
      }
    }
  }
  throw new AiCallError('AI_UNAVAILABLE', `Gemini could not write this right now (tried ${order.join(', ')}). ${failures.at(-1) ?? ''}`.trim(), 'busy');
}
