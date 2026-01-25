/**
 * Configuration storage
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { NetworkName } from '../core/network/NetworkConfig.js';
import { DATA_DIR, ensureDataDir } from './paths.js';

const ConfigSchema = z.object({
  defaultNetwork: z.enum(['mainnet', 'sepolia']).default('sepolia'),
  defaultWallet: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_FILE = join(DATA_DIR, 'config.json');

/**
 * Load configuration from file
 */
export function loadConfig(): Config {
  ensureDataDir();

  if (!existsSync(CONFIG_FILE)) {
    return ConfigSchema.parse({});
  }

  try {
    const data = readFileSync(CONFIG_FILE, 'utf-8');
    return ConfigSchema.parse(JSON.parse(data));
  } catch {
    return ConfigSchema.parse({});
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Config): void {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Update configuration
 */
export function updateConfig(updates: Partial<Config>): Config {
  const current = loadConfig();
  const updated = { ...current, ...updates };
  saveConfig(updated);
  return updated;
}

/**
 * Get default network
 */
export function getDefaultNetwork(): NetworkName {
  const config = loadConfig();
  return config.defaultNetwork;
}

/**
 * Get default wallet name
 */
export function getDefaultWallet(): string | undefined {
  const config = loadConfig();
  return config.defaultWallet;
}

/**
 * Set default wallet
 */
export function setDefaultWallet(name: string): void {
  updateConfig({ defaultWallet: name });
}
