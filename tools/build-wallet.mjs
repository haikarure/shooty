import { build } from 'esbuild';
await build({ entryPoints: ['web/wallet-source.js'], bundle: true, outfile: 'web/wallet-client.js', format: 'iife', target: 'es2022', minify: true, legalComments: 'eof' });
