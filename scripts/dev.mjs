// Herdr doesn't see edits through a symlinked mod folder; touching the link makes it reload.
import { watch, lutimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mod = new URL('../mods/pitchfork/', import.meta.url).pathname;
const link = join(process.env.HERDR_APP_HOME || join(homedir(), '.config/herdr-app'), 'mods/pitchfork');
watch(mod, { recursive: true }, (_event, file) => {
  if (/\.d\.ts$|jsconfig\.json$/.test(file ?? '')) return;
  const now = new Date();
  lutimesSync(link, now, now);
  console.log('reload', file);
});
console.log('watching', mod, '→', link);
