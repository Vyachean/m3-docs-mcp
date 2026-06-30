import type { TokenTableGraph } from '../graph/graph-types.js';

export type TokenResolutionUnresolvedExample = {
  token: string;
  tokenTableId: string;
  column: string;
  displayValue: '[unresolved]';
  unresolvedReason: 'unclassified';
};

export type TokenResolutionByRoute = {
  route: string;
  tokenTableIds: string[];
  unresolvedTokenRows: number;
  unresolvedCellCount: number;
  examples: TokenResolutionUnresolvedExample[];
};

export type TokenResolutionByTokenTable = {
  tokenTableId: string;
  resourceName: string | null;
  routes: string[];
  unresolvedTokenRows: number;
  unresolvedCellCount: number;
};

export type TokenResolutionSummary = {
  schemaVersion: 1;
  generatedAt: string;
  totalTokenTables: number;
  totalTokenRows: number;
  unresolvedTokenRows: number;
  unresolvedCellCount: number;
  unresolvedByRoute: TokenResolutionByRoute[];
  unresolvedByTokenTable: TokenResolutionByTokenTable[];
  unresolvedByReason: { unclassified: number };
};

const ROLE_DISPLAY: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  'light-high-contrast': 'Light (High Contrast)',
  'dark-high-contrast': 'Dark (High Contrast)',
};

const MAX_EXAMPLES_PER_ROUTE = 5;

export function buildTokenResolutionSummary(params: {
  tokenTableGraph: TokenTableGraph;
  generatedAt?: string;
}): TokenResolutionSummary {
  const { tokenTableGraph, generatedAt = new Date().toISOString() } = params;

  let totalTokenRows = 0;
  let totalUnresolvedRows = 0;
  let totalUnresolvedCells = 0;

  type RouteEntry = {
    tokenTableIds: Set<string>;
    unresolvedTokenRows: number;
    unresolvedCellCount: number;
    examples: TokenResolutionUnresolvedExample[];
  };

  const routeMap = new Map<string, RouteEntry>();
  const byTokenTable: TokenResolutionByTokenTable[] = [];

  for (const table of tokenTableGraph.tokenTables) {
    let tableUnresolvedRows = 0;
    let tableUnresolvedCells = 0;

    for (const tokenSet of table.tokenSets ?? []) {
      for (const token of tokenSet.tokens ?? []) {
        totalTokenRows++;
        const unresolvedValues = token.values?.filter((v) => !v.resolved) ?? [];
        if (unresolvedValues.length === 0) continue;

        totalUnresolvedRows++;
        tableUnresolvedRows++;
        tableUnresolvedCells += unresolvedValues.length;
        totalUnresolvedCells += unresolvedValues.length;

        for (const route of table.routes ?? []) {
          let entry = routeMap.get(route);
          if (!entry) {
            entry = { tokenTableIds: new Set(), unresolvedTokenRows: 0, unresolvedCellCount: 0, examples: [] };
            routeMap.set(route, entry);
          }
          entry.tokenTableIds.add(table.resourceId);
          entry.unresolvedTokenRows++;
          entry.unresolvedCellCount += unresolvedValues.length;

          if (entry.examples.length < MAX_EXAMPLES_PER_ROUTE) {
            const firstUnresolved = unresolvedValues[0];
            if (firstUnresolved) {
              entry.examples.push({
                token: token.tokenName,
                tokenTableId: table.resourceId,
                column: ROLE_DISPLAY[firstUnresolved.role] ?? firstUnresolved.role,
                displayValue: '[unresolved]',
                unresolvedReason: 'unclassified',
              });
            }
          }
        }
      }
    }

    byTokenTable.push({
      tokenTableId: table.resourceId,
      resourceName: table.resourceName,
      routes: [...(table.routes ?? [])],
      unresolvedTokenRows: tableUnresolvedRows,
      unresolvedCellCount: tableUnresolvedCells,
    });
  }

  const unresolvedByRoute: TokenResolutionByRoute[] = Array.from(routeMap.entries())
    .map(([route, entry]) => ({
      route,
      tokenTableIds: Array.from(entry.tokenTableIds),
      unresolvedTokenRows: entry.unresolvedTokenRows,
      unresolvedCellCount: entry.unresolvedCellCount,
      examples: entry.examples,
    }))
    .sort((a, b) => b.unresolvedTokenRows - a.unresolvedTokenRows);

  const unresolvedByTokenTable = byTokenTable.filter((t) => t.unresolvedTokenRows > 0);

  return {
    schemaVersion: 1,
    generatedAt,
    totalTokenTables: tokenTableGraph.tokenTables.length,
    totalTokenRows,
    unresolvedTokenRows: totalUnresolvedRows,
    unresolvedCellCount: totalUnresolvedCells,
    unresolvedByRoute,
    unresolvedByTokenTable,
    unresolvedByReason: { unclassified: totalUnresolvedRows },
  };
}
