import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('AstrBot config path is required');
const config = JSON.parse(readFileSync(file, 'utf8'));
if (!config.provider_settings || typeof config.provider_settings !== 'object') {
  throw new Error('AstrBot provider_settings is missing');
}
if (config.provider_settings.enable !== false) {
  config.provider_settings.enable = false;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
