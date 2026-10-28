import { build } from 'vite';
import { gui } from '@opencode/plugin/gui/vite';
import { fileURLToPath } from 'node:url';

await build({
  root: fileURLToPath(new URL('.', import.meta.url)),
  configFile: false,
  plugins: [gui({ entry: 'src/desktop/prompts.ts', outFile: 'dist/gui-experimental.cjs' })],
  build: { emptyOutDir: false },
});
