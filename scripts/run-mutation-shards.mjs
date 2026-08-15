#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

const JSON_CONFIG = 'stryker-json-extraction.config.json';
const FULL_CONFIG = 'stryker.config.json';
const JSON_GLOB = 'src/json-extraction/**/*.ts';
const REPORT_DIR = 'reports/mutation-shards';

const shards = {
  'json-content': {
    config: JSON_CONFIG,
    mutate: [
      'src/json-extraction/classify-json-response.ts',
      'src/json-extraction/extract-content-page.ts',
      'src/json-extraction/extract-dsdb-resource.ts',
      'src/json-extraction/extract-page-data.ts',
      'src/json-extraction/json-bundle.ts'
    ],
    testFiles: [
      'tests/build-renderer-report.test.ts',
      'tests/docs-values.test.ts',
      'tests/json-extraction.test.ts',
      'tests/markdown-renderer-from-raw.test.ts',
      'tests/mcp-output.test.ts',
      'tests/tolerant-decoders.test.ts'
    ]
  },
  'json-schema-markdown': {
    config: JSON_CONFIG,
    mutate: [
      'src/json-extraction/schemas.ts',
      'src/json-extraction/render-markdown.ts'
    ],
    testFiles: [
      'tests/build-graph-token-tables.test.ts',
      'tests/json-extraction.test.ts',
      'tests/mcp-output.test.ts',
      'tests/token-resolution-classify.test.ts',
      'tests/token-table.test.ts',
      'tests/tolerant-decoders.test.ts',
      'tests/typography-token-quality.test.ts'
    ]
  },
  'json-network': {
    config: JSON_CONFIG,
    mutate: [
      'src/json-extraction/capture-network-json.ts',
      'src/json-extraction/fetch-json-page.ts',
      'src/json-extraction/fetch-site-meta.ts'
    ],
    testFiles: [
      'tests/fetch-diagnostics-recording.test.ts',
      'tests/fetch-page-data-by-reference.test.ts',
      'tests/fetch-site-meta.test.ts',
      'tests/json-extraction.test.ts',
      'tests/progress-concurrency.test.ts',
      'tests/route-graph.test.ts'
    ]
  },
  'json-diagnostics': {
    config: JSON_CONFIG,
    mutate: ['src/json-extraction/diagnostics.ts'],
    testFiles: [
      'tests/build-graph-status-tables.test.ts',
      'tests/cache.test.ts',
      'tests/diagnostics.test.ts',
      'tests/json-extraction.test.ts',
      'tests/markdown-renderer-from-raw.test.ts',
      'tests/markdown-renderer-switch-alias-rebuild.test.ts',
      'tests/markdown-renderer-tab-rebuild.test.ts'
    ]
  },
  'json-routing': {
    config: JSON_CONFIG,
    mutate: [
      'src/json-extraction/normalize-routes.ts',
      'src/json-extraction/page-reference-resolver.ts',
      'src/json-extraction/route-graph.ts'
    ],
    testFiles: [
      'tests/normalize-routes.test.ts',
      'tests/page-reference-resolver.test.ts',
      'tests/route-graph.test.ts'
    ]
  },
  'core-cache': {
    config: FULL_CONFIG,
    mutate: ['src/cache.ts'],
    testFiles: [
      'tests/cache.test.ts',
      'tests/mcp-server.test.ts',
      'tests/mcp-tools.test.ts',
      'tests/store.test.ts',
      'tests/update-logger.test.ts',
      'tests/validate-coverage-summary.test.ts',
      'tests/validate-manifest-consistency.test.ts'
    ]
  },
  'core-store-mcp': {
    config: FULL_CONFIG,
    mutate: ['src/store.ts', 'src/mcp-server.ts'],
    testFiles: [
      'tests/mcp-server.test.ts',
      'tests/mcp-tools.test.ts',
      'tests/store-refresh.test.ts',
      'tests/store.test.ts'
    ]
  },
  'core-options-utils': {
    config: FULL_CONFIG,
    mutate: ['src/options.ts', 'src/crawler-utils.ts'],
    testFiles: [
      'tests/crawler-utils.test.ts',
      'tests/options.test.ts',
      'tests/progress-concurrency.test.ts'
    ]
  }
};

const suites = {
  'json-extraction': ['json-content', 'json-schema-markdown', 'json-network', 'json-diagnostics', 'json-routing'],
  full: ['json-content', 'json-schema-markdown', 'json-network', 'json-diagnostics', 'json-routing', 'core-cache', 'core-store-mcp', 'core-options-utils']
};

const [command, arg] = process.argv.slice(2);
const scopes = await verifyShardDefinitions();

switch (command) {
  case 'check':
    console.log(`Mutation shard definitions are complete: ${Object.keys(shards).length} shard(s).`);
    break;
  case 'shard':
    assertKnownShard(arg);
    process.exitCode = await runShard(arg);
    break;
  case 'aggregate':
    assertKnownSuite(arg);
    process.exitCode = await enforceAggregateScore(arg, suites[arg], scopes[configForSuite(arg)].config);
    break;
  case 'suite':
    assertKnownSuite(arg);
    process.exitCode = await runSuite(arg, suites[arg], scopes[configForSuite(arg)].config);
    break;
  default:
    throw new Error('Usage: run-mutation-shards.mjs check | shard <name> | aggregate <suite> | suite <suite>');
}

function assertKnownShard(name) {
  if (!name || !shards[name]) throw new Error(`Unknown mutation shard: ${name ?? '(missing)'}`);
}

function assertKnownSuite(name) {
  if (!name || !suites[name]) throw new Error(`Unknown mutation suite: ${name ?? '(missing)'}`);
}

function configForSuite(name) {
  return name === 'json-extraction' ? JSON_CONFIG : FULL_CONFIG;
}

async function verifyShardDefinitions() {
  const expectedJsonFiles = await listJsonExtractionSourceFiles();
  const configScopes = {
    [JSON_CONFIG]: await readMutationConfigScope(JSON_CONFIG, expectedJsonFiles),
    [FULL_CONFIG]: await readMutationConfigScope(FULL_CONFIG, expectedJsonFiles)
  };

  for (const [suiteName, configPath] of [['json-extraction', JSON_CONFIG], ['full', FULL_CONFIG]]) {
    const suiteFiles = suites[suiteName].flatMap((name) => shards[name].mutate).sort();
    assertUnique(suiteFiles, `${suiteName} mutation targets`);
    assertSameSet(suiteFiles, configScopes[configPath].mutate, `${suiteName} mutation targets`);
  }

  for (const [name, shard] of Object.entries(shards)) {
    if (shard.mutate.length === 0 || shard.testFiles.length === 0) {
      throw new Error(`Mutation shard ${name} must own both production files and test files.`);
    }
    const configScope = configScopes[shard.config];
    assertSubset(shard.mutate, configScope.mutate, `${name} mutation targets`);
    assertSubset(shard.testFiles, configScope.testFiles, `${name} test files`);
    await Promise.all([...shard.mutate, ...shard.testFiles, shard.config].map(assertFileExists));
  }

  return configScopes;
}

async function listJsonExtractionSourceFiles() {
  return (await readdir('src/json-extraction', { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `src/json-extraction/${entry.name}`)
    .sort();
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
    mutate: [...new Set(included.filter((target) => !excluded.has(target)))].sort(),
    testFiles: [...new Set(config.testFiles ?? [])].sort()
  };
}

async function assertFileExists(path) {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Expected file for mutation shard does not exist: ${path}`);
}

function assertUnique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) throw new Error(`${label} contain duplicates: ${[...new Set(duplicates)].join(', ')}`);
}

function assertSubset(actual, expected, label) {
  const expectedSet = new Set(expected);
  const extra = actual.filter((value) => !expectedSet.has(value));
  if (extra.length > 0) throw new Error(`${label} are outside the base Stryker config: ${extra.join(', ')}`);
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

async function runSuite(suiteName, names, baseConfig) {
  await rm(REPORT_DIR, { recursive: true, force: true });
  await mkdir(REPORT_DIR, { recursive: true });

  for (const name of names) {
    const exitCode = await runShard(name);
    if (exitCode !== 0) return exitCode;
  }

  return enforceAggregateScore(suiteName, names, baseConfig);
}

async function runShard(name) {
  const shard = shards[name];
  const baseConfig = JSON.parse(await readFile(shard.config, 'utf8'));
  const configPath = `.stryker-shard-${name}.json`;
  const reportPath = `${REPORT_DIR}/${name}.json`;
  const shardConfig = {
    ...baseConfig,
    reporters: ['progress', 'clear-text', 'json'],
    mutate: shard.mutate,
    testFiles: shard.testFiles,
    tempDirName: `.stryker-tmp-${name}`,
    thresholds: { ...baseConfig.thresholds, break: 0 },
    jsonReporter: { fileName: reportPath }
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(shardConfig, null, 2)}\n`);
  console.log(`[mutation:${name}] mutate=${shard.mutate.length} testFiles=${shard.testFiles.length}`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(npm, ['exec', '--', 'stryker', 'run', configPath], { stdio: 'inherit', env: process.env });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) {
          console.error(`[mutation:${name}] terminated by ${signal}`);
          resolve(1);
          return;
        }
        console.log(`[mutation:${name}] exit=${code ?? 1}`);
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
