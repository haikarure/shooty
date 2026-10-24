// Build a source-verification bundle locally. No RPC, signer, or broadcast is used.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, input = '') {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) rejectRun(error);
      else resolveRun(stdout);
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') rejectRun(error);
    });
    child.stdin.end(input);
  });
}

export async function exportVerification({
  projectRoot = root,
  outputDir = resolve(root, 'deployment/verification'),
  solc = process.env.FOUNDRY_SOLC || 'solc',
} = {}) {
  const artifact = JSON.parse(readFileSync(resolve(projectRoot, 'out/ShootyArena.sol/ShootyArena.json'), 'utf8'));
  const metadata = artifact.metadata;
  const sources = {};
  for (const [name, info] of Object.entries(metadata.sources)) {
    const sourcePath = resolve(projectRoot, name);
    const location = relative(projectRoot, sourcePath);
    if (isAbsolute(location) || location === '..' || location.startsWith('../')) {
      throw new Error(`Source path outside project: ${name}`);
    }
    const content = readFileSync(sourcePath, 'utf8');
    const hash = (await run('cast', ['keccak'], '0x' + Buffer.from(content).toString('hex'))).trim();
    if (hash !== info.keccak256) throw new Error(`Stale artifact: ${name}; rebuild before exporting`);
    sources[name] = { content };
  }

  const settings = structuredClone(metadata.settings);
  delete settings.compilationTarget;
  settings.outputSelection = {
    'src/ShootyArena.sol': { ShootyArena: ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'] },
  };
  const standardJsonInput = { language: metadata.language, sources, settings };
  const result = JSON.parse(await run(solc, ['--standard-json'], JSON.stringify(standardJsonInput)));
  const errors = (result.errors || []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const compiled = result.contracts?.['src/ShootyArena.sol']?.ShootyArena;
  if (!compiled || '0x' + compiled.evm.bytecode.object !== artifact.bytecode.object) {
    throw new Error('Exported sources/settings did not reproduce creation bytecode');
  }
  if ('0x' + compiled.evm.deployedBytecode.object !== artifact.deployedBytecode.object) {
    throw new Error('Exported sources/settings did not reproduce runtime bytecode');
  }
  const files = {
    'standard-input.json': standardJsonInput,
    'metadata.json': metadata,
    'manifest.json': {
      contractName: 'src/ShootyArena.sol:ShootyArena',
      chainId: 10143,
      compilerVersion: 'v' + metadata.compiler.version,
      contractAddress: null,
      broadcast: false,
      sourceCount: Object.keys(sources).length,
      creationBytecodeSha256: createHash('sha256').update(Buffer.from(artifact.bytecode.object.slice(2), 'hex')).digest('hex'),
      sourceBytecodeReproduced: true,
    },
  };
  mkdirSync(outputDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(resolve(outputDir, name), JSON.stringify(data, null, 2) + '\n');
  }
  return files['manifest.json'];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  try {
    if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output requires a directory');
    const outputDir = outputIndex === -1 ? undefined : resolve(process.argv[outputIndex + 1]);
    const manifest = await exportVerification({ outputDir });
    console.log(`Verification bundle exported: ${manifest.sourceCount} sources; bytecode reproduced; no transaction sent`);
  } catch (error) {
    console.error(`Verification export failed: ${error.message}`);
    process.exitCode = 1;
  }
}
