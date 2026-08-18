#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';
import ts from 'typescript';

const JSON_CONFIG = 'stryker-json-extraction.config.json';
const FULL_CONFIG = 'stryker.config.json';
const JSON_GLOB = 'src/json-extraction/**/*.ts';
const REPORT_DIR = 'reports/mutation-shards';

const wholeFile = (path) => ({ path });
const lineRange = (path, startLine, endLine = null) => ({ path, startLine, endLine });

const CONTENT_PAGE = 'src/json-extraction/extract-content-page.ts';
const RENDER_MARKDOWN = 'src/json-extraction/render-markdown.ts';
const PAGE_REFERENCE = 'src/json-extraction/page-reference-resolver.ts';

const shards = {
  'json-classify-response': [wholeFile('src/json-extraction/classify-json-response.ts')],
  'json-content-page-1': [lineRange(CONTENT_PAGE, 1, 139)],
  'json-content-page-2': [lineRange(CONTENT_PAGE, 140, 249)],
  'json-content-page-3': [lineRange(CONTENT_PAGE, 250)],
  'json-dsdb-resource': [wholeFile('src/json-extraction/extract-dsdb-resource.ts')],
  'json-page-data': [wholeFile('src/json-extraction/extract-page-data.ts')],
  'json-bundle': [wholeFile('src/json-extraction/json-bundle.ts')],
  'json-schemas': [wholeFile('src/json-extraction/schemas.ts')],
  'json-render-markdown-1': [lineRange(RENDER_MARKDOWN, 1, 142)],
  'json-render-markdown-2': [lineRange(RENDER_MARKDOWN, 143, 279)],
  'json-render-markdown-3': [lineRange(RENDER_MARKDOWN, 280, 408)],
  'json-render-markdown-4': [lineRange(RENDER_MARKDOWN, 409, 495)],
  'json-render-markdown-5': [lineRange(RENDER_MARKDOWN, 496, 587)],
  'json-render-markdown-6': [lineRange(RENDER_MARKDOWN, 588, 668)],
  'json-render-markdown-7': [lineRange(RENDER_MARKDOWN, 669)],
  'json-network': [
    wholeFile('src/json-extraction/capture-network-json.ts'),
    wholeFile('src/json-extraction/fetch-json-page.ts'),
    wholeFile('src/json-extraction/fetch-site-meta.ts')
  ],
  'json-diagnostics': [wholeFile('src/json-extraction/diagnostics.ts')],
  'json-normalize-routes': [wholeFile('src/json-extraction/normalize-routes.ts')],
  'json-page-reference-1': [lineRange(PAGE_REFERENCE, 1, 133)],
  'json-page-reference-2': [lineRange(PAGE_REFERENCE, 134, 286)],
  'json-page-reference-3': [lineRange(PAGE_REFERENCE, 287)],
  'json-route-graph': [wholeFile('src/json-extraction/route-graph.ts')],
  'core-cache': [wholeFile('src/cache.ts')],
  'core-store-mcp': [wholeFile('src/store.ts'), wholeFile('src/mcp-server.ts')],
  'core-options-utils': [wholeFile('src/options.ts'), wholeFile('src/crawler-utils.ts')]
};

const jsonShards = [
  'json-classify-response',
  'json-content-page-1',
  'json-content-page-2',
  'json-content-page-3',
  'json-dsdb-resource',
  'json-page-data',
  'json-bundle',
  'json-schemas',
  'json-render-markdown-1',
  'json-render-markdown-2',
  'json-render-markdown-3',
  'json-render-markdown-4',
  'json-render-markdown-5',
  'json-render-markdown-6',
  'json-render-markdown-7',
  'json-network',
  'json-diagnostics',
  'json-normalize-routes',
  'json-page-reference-1',
  'json-page-reference-2',
  'json-page-reference-3',
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

  const allShardPaths = [...new Set(Object.values(shards).flat().map(({ path }) => path))];
  await Promise.all([...allShardPaths, JSON_CONFIG, FULL_CONFIG].map(assertFileExists));
  const sourceMetadata = new Map(await Promise.all(allShardPaths.map(async (path) => [path, await readSourceMetadata(path)])));
  const lineCounts = new Map([...sourceMetadata].map(([path, metadata]) => [path, metadata.lineCount]));

  for (const [suiteName, configPath] of [['json-extraction', JSON_CONFIG], ['full', FULL_CONFIG]]) {
    const expectedFiles = configScopes[configPath].mutate;
    const descriptors = suites[suiteName].flatMap((name) => shards[name]);
    assertSameSet([...new Set(descriptors.map(({ path }) => path))].sort(), expectedFiles, `${suiteName} mutation target files`);
    verifyCompleteRanges(suiteName, descriptors, expectedFiles, sourceMetadata);
  }

  return { ...configScopes, lineCounts };
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
    else if (!target.includes('*') && !target.includes(':')) included.push(target);
    else throw new Error(`Unsupported canonical mutation target in ${path}: ${target}`);
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

async function readSourceMetadata(path) {
  const source = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  if (source.length === 0) throw new Error(`Mutation target is empty: ${path}`);
  const withoutFinalNewline = source.endsWith('\n') ? source.slice(0, -1) : source;
  return {
    lineCount: withoutFinalNewline.split('\n').length,
    sourceFile: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
}

function verifyCompleteRanges(suiteName, descriptors, expectedFiles, sourceMetadata) {
  for (const path of expectedFiles) {
    const fileDescriptors = descriptors.filter((descriptor) => descriptor.path === path);
    const metadata = sourceMetadata.get(path);
    if (!metadata) throw new Error(`Missing source metadata for mutation target: ${path}`);
    const { lineCount, sourceFile } = metadata;

    const wholeFileDescriptors = fileDescriptors.filter(({ startLine, endLine }) => startLine === undefined && endLine === undefined);
    if (wholeFileDescriptors.length > 0) {
      if (wholeFileDescriptors.length !== 1 || fileDescriptors.length !== 1) {
        throw new Error(`${suiteName} mutation target ${path} mixes or duplicates whole-file and ranged shards.`);
      }
      continue;
    }

    const ranges = fileDescriptors.map(({ startLine, endLine }) => {
      if (!Number.isInteger(startLine) || startLine < 1) throw new Error(`${suiteName} mutation target ${path} has invalid start line: ${startLine}`);
      const resolvedEnd = endLine === null ? lineCount : endLine;
      if (!Number.isInteger(resolvedEnd) || resolvedEnd < startLine || resolvedEnd > lineCount) {
        throw new Error(`${suiteName} mutation target ${path} has invalid range ${startLine}-${resolvedEnd}; file has ${lineCount} lines.`);
      }
      return { startLine, endLine: resolvedEnd };
    }).sort((a, b) => a.startLine - b.startLine);

    if (ranges.length === 0 || ranges[0].startLine !== 1) {
      throw new Error(`${suiteName} mutation ranges for ${path} must start at line 1.`);
    }
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      if (current.startLine !== previous.endLine + 1) {
        throw new Error(`${suiteName} mutation ranges for ${path} have a gap or overlap between ${previous.endLine} and ${current.startLine}.`);
      }
    }
    if (ranges.at(-1)?.endLine !== lineCount) {
      throw new Error(`${suiteName} mutation ranges for ${path} stop before EOF (${ranges.at(-1)?.endLine}/${lineCount}).`);
    }

    assertTopLevelSafeBoundaries(suiteName, path, ranges, sourceFile);
  }
}

function assertTopLevelSafeBoundaries(suiteName, path, ranges, sourceFile) {
  for (const range of ranges.slice(0, -1)) {
    const boundaryLine = range.endLine;
    const crossingStatement = sourceFile.statements.find((statement) => {
      const startLine = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
      const lastPosition = Math.max(statement.getStart(sourceFile), statement.getEnd() - 1);
      const endLine = sourceFile.getLineAndCharacterOfPosition(lastPosition).line + 1;
      return startLine <= boundaryLine && endLine > boundaryLine;
    });
    if (crossingStatement) {
      const kind = ts.SyntaxKind[crossingStatement.kind] ?? String(crossingStatement.kind);
      throw new Error(`${suiteName} mutation boundary after ${path}:${boundaryLine} splits top-level ${kind}; range shards must split only between top-level statements.`);
    }
  }
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

function materializeMutationTargets(name) {
  return shards[name].map(({ path, startLine, endLine }) => {
    if (startLine === undefined && endLine === undefined) return path;
    const lineCount = scopes.lineCounts.get(path);
    const resolvedEnd = endLine === null ? lineCount : endLine;
    return `${path}:${startLine}-${resolvedEnd}`;
  });
}

async function runShard(suiteName, name) {
  const baseConfig = JSON.parse(await readFile(configForSuite(suiteName), 'utf8'));
  const configPath = `.stryker-shard-${suiteName}-${name}.json`;
  const reportPath = `${REPORT_DIR}/${name}.json`;
  const mutationTargets = materializeMutationTargets(name);
  const shardConfig = {
    ...baseConfig,
    reporters: ['progress', 'clear-text', 'json'],
    mutate: mutationTargets,
    tempDirName: `.stryker-tmp-${suiteName}-${name}`,
    thresholds: { ...baseConfig.thresholds, break: 0 },
    jsonReporter: { fileName: reportPath }
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(shardConfig, null, 2)}\n`);
  console.log(`[mutation:${suiteName}/${name}] mutate=${mutationTargets.join(', ')}; test discovery inherited from ${configForSuite(suiteName)}`);

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
