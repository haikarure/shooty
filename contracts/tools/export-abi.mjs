import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = JSON.parse(readFileSync(`${root}out/ShootyArena.sol/ShootyArena.json`, 'utf8'));
mkdirSync(`${root}abi`, { recursive: true });
writeFileSync(`${root}abi/ShootyArena.json`, JSON.stringify(artifact.abi, null, 2) + '\n');
console.log('Exported abi/ShootyArena.json from the compiled implementation');
