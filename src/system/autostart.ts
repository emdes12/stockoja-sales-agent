import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { ROOT_DIR } from '../config.js';

/**
 * Optional "start with Windows": a small launcher in your Startup folder that runs start-agent.bat, minimised,
 * when you sign in to Windows. Only the app starts; the agent itself starts only if "Start the agent
 * automatically when I open the app" is also on. Turning the option off deletes the launcher. Nothing else in
 * Windows is changed (no registry, no service, no scheduled task).
 */
export const LAUNCHER_NAME = 'StockOja Sales Agent.cmd';
const MARKER = 'rem Added by StockOja Sales Agent';

export const autostartDeps = {
  /** The current user's Startup folder. Replaceable in tests. */
  startupDir: () => (process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null),
  platform: () => process.platform,
};

export function launcherContent(root = ROOT_DIR) {
  const bat = path.join(root, 'start-agent.bat');
  return [
    '@echo off',
    `${MARKER} (Settings > Start-up > Start with Windows).`,
    'rem Turn the option off in Settings, or delete this file, to stop it.',
    `start "StockOja Sales Agent" /min cmd /c ""${bat}" --background"`,
    '',
  ].join('\r\n');
}

function launcherPath() {
  const dir = autostartDeps.startupDir();
  return dir ? path.join(dir, LAUNCHER_NAME) : null;
}

export async function autostartStatus() {
  const file = launcherPath();
  const supported = autostartDeps.platform() === 'win32' && !!file && existsSync(path.dirname(file));
  let enabled = false;
  if (supported && existsSync(file!)) enabled = (await readFile(file!, 'utf8')).includes(MARKER);
  return { supported, enabled, path: supported ? file : null };
}

export async function setAutostart(enabled: boolean) {
  const status = await autostartStatus();
  if (!status.supported) throw new Error('Starting with Windows is only available on Windows.');
  const file = status.path!;
  if (enabled) await writeFile(file, launcherContent(), 'utf8');
  else if (existsSync(file) && (await readFile(file, 'utf8')).includes(MARKER)) await unlink(file); // never remove a file we didn't write
  return autostartStatus();
}
