import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';
import { getProviderById } from '../providers.js';
import { appPath, getAppDir } from './paths.js';

/** Owner-only: this file stores API keys. Matches the wallet file's mode. */
export const ENV_FILE_MODE = 0o600;

// Resolve .env from a CWD override (dev workflow) or the home config dir
// (default for `bunx` / global installs). The home path is also where
// `saveApiKeyToEnv` writes new keys.
const HOME_ENV_PATH = appPath('.env');
const CWD_ENV_PATH = resolve(process.cwd(), '.env');
export const ENV_PATH = existsSync(CWD_ENV_PATH) ? CWD_ENV_PATH : HOME_ENV_PATH;

// Load .env on module import
config({ path: ENV_PATH, quiet: true });

export function getApiKeyNameForProvider(providerId: string): string | undefined {
  return getProviderById(providerId)?.apiKeyEnvVar;
}

export function getProviderDisplayName(providerId: string): string {
  return getProviderById(providerId)?.displayName ?? providerId;
}

export function checkApiKeyExistsForProvider(providerId: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return true;
  return checkApiKeyExists(apiKeyName);
}

export function checkApiKeyExists(apiKeyName: string): boolean {
  const value = process.env[apiKeyName];
  if (value && value.trim() && !value.trim().startsWith('your-')) {
    return true;
  }

  // Also check .env file directly
  if (existsSync(ENV_PATH)) {
    const envContent = readFileSync(ENV_PATH, 'utf-8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key.trim() === apiKeyName) {
          const val = valueParts.join('=').trim();
          if (val && !val.startsWith('your-')) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

export function saveApiKeyToEnv(apiKeyName: string, apiKeyValue: string): boolean {
  try {
    let lines: string[] = [];
    let keyUpdated = false;

    if (existsSync(ENV_PATH)) {
      const existingContent = readFileSync(ENV_PATH, 'utf-8');
      const existingLines = existingContent.split('\n');

      for (const line of existingLines) {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith('#')) {
          lines.push(line);
        } else if (stripped.includes('=')) {
          const key = stripped.split('=')[0].trim();
          if (key === apiKeyName) {
            lines.push(`${apiKeyName}=${apiKeyValue}`);
            keyUpdated = true;
          } else {
            lines.push(line);
          }
        } else {
          lines.push(line);
        }
      }

      if (!keyUpdated) {
        if (lines.length > 0 && !lines[lines.length - 1].endsWith('\n')) {
          lines.push('');
        }
        lines.push(`${apiKeyName}=${apiKeyValue}`);
      }
    } else {
      lines.push('# LLM API Keys');
      lines.push(`${apiKeyName}=${apiKeyValue}`);
    }

    mkdirSync(getAppDir(), { recursive: true });
    // This file holds OCTAGON_API_KEY and the LLM keys, and the README points
    // users at it. Without a mode it lands at the umask default — typically
    // 0644 — readable by every other account on the machine. The mode argument
    // is ignored when the file already exists, so chmod unconditionally after.
    writeFileSync(ENV_PATH, lines.join('\n'), { mode: ENV_FILE_MODE });
    try {
      chmodSync(ENV_PATH, ENV_FILE_MODE);
    } catch {
      // Windows and some network filesystems have no POSIX modes. The write
      // succeeded; refusing here would be worse than the weaker permissions.
    }

    // Reload environment variables
    config({ path: ENV_PATH, override: true, quiet: true });

    return true;
  } catch {
    return false;
  }
}

export function saveApiKeyForProvider(providerId: string, apiKey: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return false;
  return saveApiKeyToEnv(apiKeyName, apiKey);
}
