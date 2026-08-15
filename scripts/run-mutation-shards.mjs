#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

const JSON_CONFIG = 'stryker-json-extraction.config.json';
const FULL_CONFIG = 'stryker.config.json';
const JSON_GLOB = 'src/json-extraction/**/*.ts';
const REPORT_DIR = 'reports/mutation-shards';

const shards = {
  'json-classify-response': ['src/json-extraction/classify-json-response.ts'],
  'json-content-page': ['src/json-extraction/extract-content-page.ts'],
  'json-dsdb-resource': ['src/json-extraction/extract-dsdb-resource.ts'],
  'json-page-data': ['src/json-extraction/extract-page-data.ts'],
  'json-bundle': ['src/json-extraction/json-bundle.ts'],
  'json-schemas': ['src/json-extraction/schemas.ts'],
  'json-render-markdown': ['src/json-extraction/render-markdown.ts'],
  'json-network': [
    'src/json-extraction/capture-network-json.ts',
    'src/json-extraction/fetch-json-page.ts',
    'src/json-extraction/fetch-site-meta.ts'
  ],
  'json-diagnostics': ['src/json-extraction/diagnostics.ts'],
  'json-normalize-routes': ['src/json-extraction/normalize-routes.ts'],
  'json-page-reference': ['src/json-extraction/page-reference-resolver.ts'],
  'json-route-graph': ['src/json-extraction/route-graph.ts'],
  'core-cache': ['src/cache.ts'],
  'core-store-mcp': ['src/store.ts', 'src/mcp-server.ts'],
  'core-options-utils': ['src/options.ts', 'src/crawler-utils.ts']
};

const jsonShards = [
  'json-classify-response',
  'json-content-page',
  'json-dsdb-resource',
  'json-page-data',
  'json-bundle',
  'json-schemas',
  'json-render-markdown',
  'json-network',
  'json-diagnostics',
  'json-normalize-routes',
  'json-page-reference',
  'json-route-graph'
];

const suites = {
  'json-extraction': jsonShards,
  full: [...jsonShards, 'core-cache', 'core-store-mcp', 'core-options-utils']
};

const [command, ...args] = process.argv.slice(2);
const scopes = await verifyShardDefinitions();

switch (command) {
  case 'check':
    console.log(`Mutation shard definitions are complete: ${Object.keys(shards).length} shard(s).`);
    break;
  case 'shard': {
    const [suiteName, shardName] = args;
    assertShardInSuite(suiteName, shardName);
    process.exitCode = await runShard(suiteName, shardName);
    break;
  }
  case 'aggregate': {
    const [suiteName] = args;
    assertKnownSuite(suiteName);
    process.exitCode = await enforceAggregateScore(suiteName, suites[suiteName], scopes[configForSuite(suiteName)].config);
    break;
  }
  default:
    throw new Error('Usage: run-mutation-shards.mjs check | shard <suite> <name> | aggregate <suite>');
}

function assertKnownSuite(name) {
  if (!name || !suites[name]) throw new Error(`Unknown mutation suite: ${name ?? '(missing)'}`);
}

function assertShardInSuite(suiteName, shardName) {
  assertKnownSuite(suiteName);
  if (!shardName || !shards[shardName]) throw new Error(`Unknown mutation shard: ${shardName ?? '(missing)'}`);
  if (!suites[suiteName].includes(shardName)) throw new Error(`Mutation shard ${shardName} does not belong to suite ${suiteName}.`);
}

function configForSuite(name) {
  return name === 'json-extraction' ? JSON_CONFIG : FULL_CONFIG;
}

async function verifyShardDefinitions() {
  const expectedJsonFiles = await listTypeScriptFiles('src/json-extraction');
  const configScopes = {
    [JSON_CONFIG]: await readMutationConfigScope(JSON_CONFIG, expectedJsonFiles),
    [FULL_CONFIG]: await readMutationConfigScope(FULL_CONFIG, expectedJsonFiles)
  };

  for (const [suiteName, configPath] of [['json-extraction', JSON_CONFIG], ['full', FULL_CONFIG]]) {
    const suiteFiles = suites[suiteName].flatMap((name) => shards[name]).sort();
    assertUnique(suiteFiles, `${suiteName} mutation targets`);
    assertSameSet(suiteFiles, configScopes[configPath].mutate, `${suiteName} mutation targets`);
    await Promise.all([...suiteFiles, configPath].map(assertFileExists));
  }

  return configScopes;
}

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

async function readMutationConfigScope(path, jsonFiles) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const included = [];
  const excluded = new Set();

  for (const target of config.mutate ?? []) {
    if (target === JSON_GLOB) included.push(...jsonFiles);
    else if (target.startsWith('!')) excluded.add(target.slice(1));
    else if (!target.includes('*')) included.push(target);
    else throw new Error(`Unsupported mutation glob in ${path}: ${target}`);
  }

  return {
    config,
    mutate: [...new Set(included.filter((target) => !excluded.has(target)))].sort()
  };
}

async function assertFileExists(path) {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Expected mutation file does not exist: ${path}`);
}

function assertUnique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) throw new Error(`${label} contain duplicates: ${[...new Set(duplicates)].join(', ')}`);
}

function assertSameSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || extra.length) {
    throw new Error(`${label} drifted. Missing: ${missing.join(', ') || '(none)'}. Extra: ${extra.join(', ') || '(none)'}.`);
  }
}

async function runShard(suiteName, name) {
  const baseConfig = JSON.parse(await readFile(configForSuite(suiteName), 'utf8'));
  const configPath = `.stryker-shard-${suiteName}-${name}.json`;
  const reportPath = `${REPORT_DIR}/${name}.json`;
  const shardConfig = {
    ...baseConfig,
    reporters: ['progress', 'clear-text', 'json'],
    mutate: shards[name],
    tempDirName: `.stryker-tmp-${suiteName}-${name}`,
    thresholds: { ...baseConfig.thresholds, break: 0 },
    jsonReporter: { fileName: reportPath }
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(shardConfig, null, 2)}\n`);
  console.log(`[mutation:${suiteName}/${name}] mutate=${shards[name].length}; test discovery inherited from ${configForSuite(suiteName)}`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(npm, ['exec', '--', 'stryker', 'run', configPath], { stdio: 'inherit', env: process.env });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) {
          console.error(`[mutation:${suiteName}/${name}] terminated by ${signal}`);
          resolve(1);
          return;
        }
        console.log(`[mutation:${suiteName}/${name}] exit=${code ?? 1}`);
        resolve(code ?? 1);
      });
    });
  } finally {
    await rm(configPath, { force: true });
  }
}

async function enforceAggregateScore(suiteName, names, baseConfig) {
  const counts = new Map();

  for (const name of names) {
    const reportPath = `${REPORT_DIR}/${name}.json`;
    await assertFileExists(reportPath);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const file of Object.values(report.files ?? {})) {
      for (const mutant of file.mutants ?? []) {
        counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
      }
    }
  }

  const pending = counts.get('Pending') ?? 0;
  if (pending > 0) throw new Error(`Mutation suite ${suiteName} produced ${pending} pending mutant(s).`);

  const killed = counts.get('Killed') ?? 0;
  const timeout = counts.get('Timeout') ?? 0;
  const survived = counts.get('Survived') ?? 0;
  const noCoverage = counts.get('NoCoverage') ?? 0;
  const runtimeError = counts.get('RuntimeError') ?? 0;
  const compileError = counts.get('CompileError') ?? 0;
  const ignored = counts.get('Ignored') ?? 0;
  const valid = killed + timeout + survived + noCoverage;
  if (valid === 0) throw new Error(`Mutation suite ${suiteName} produced no valid mutants.`);

  const detected = killed + timeout;
  const score = detected / valid * 100;
  const breakThreshold = Number(baseConfig.thresholds?.break ?? 0);

  console.log(`[mutation:${suiteName}] aggregate score=${score.toFixed(2)}% detected=${detected} valid=${valid} killed=${killed} timeout=${timeout} survived=${survived} noCoverage=${noCoverage} runtimeError=${runtimeError} compileError=${compileError} ignored=${ignored} break=${breakThreshold}`);
  if (score < breakThreshold) {
    console.error(`[mutation:${suiteName}] aggregate mutation score ${score.toFixed(2)}% is below break threshold ${breakThreshold}%.`);
    return 1;
  }
  return 0;
}
