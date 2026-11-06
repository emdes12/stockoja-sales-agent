// Runs before every test file: no test may call (or pay for) the real Gemini API, or wait between retries.
// Tests that need AI set GEMINI_API_KEY and replace aiDeps.generate themselves.
import { env } from '../src/config.js';
import { aiDeps } from '../src/ai/gemini.js';
import { OutreachError } from '../src/outreach/messages.js';

env.GEMINI_API_KEY = '';
env.GEMINI_FALLBACK_MODELS = '';
env.TELEGRAM_BOT_TOKEN = '';
aiDeps.generate = async () => {
  throw new OutreachError('AI_FAILED', 'Tests never call the real Gemini API.');
};
aiDeps.listModels = async () => [];
aiDeps.sleep = async () => {};
