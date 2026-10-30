// esm + cjs with esbuild, declarations with tsc (dist/index.d.ts, copied to .d.cts for require users).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

rmSync('dist', { recursive: true, force: true });
const common = { entryPoints: ['src/index.ts'], bundle: true, platform: 'neutral', target: 'node18', sourcemap: true };
await build({ ...common, format: 'esm', outfile: 'dist/index.js' });
await build({ ...common, format: 'cjs', outfile: 'dist/index.cjs' });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit', 'false', '--emitDeclarationOnly', '--declaration', '--outDir', 'dist'], { stdio: 'inherit' });
copyFileSync('dist/index.d.ts', 'dist/index.d.cts');
