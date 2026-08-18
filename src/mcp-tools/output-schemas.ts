import { z } from 'zod';
import {
  ResourceNodeSchema,
  RouteNodeSchema,
  RouteTabNodeSchema,
  TokenTableNodeSchema,
} from '../graph/graph-types.js';

const MessageSchema = z.string().nullable();

/**
 * Compatibility/debug tools have historically returned broad diagnostic/cache payloads whose
 * nested shapes evolve independently. They still advertise an object output contract and return
 * structuredContent, while graph-oriented tools below expose stable field-level schemas.
 */
export const CompatibilityObjectOutputSchema = z.object({}).passthrough();

export const ListRoutesOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  totalMatched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  routes: z.array(z.object({
    route: z.string(),
    title: z.string().nullable(),
    section: z.string().nullable(),
    canonicalRoute: z.string().nullable(),
    coverageStatus: z.string(),
    hasStructuredPage: z.boolean(),
    hasMarkdown: z.boolean(),
  })),
});

export const GetRouteOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  found: z.boolean(),
  route: RouteNodeSchema.nullable(),
});

const StructuredPageSchema = z.object({
  pageId: z.string(),
  route: z.string(),
  title: z.string(),
  section: z.string(),
  tabs: z.array(z.object({ label: z.string(), route: z.string() }).passthrough()),
  headings: z.array(z.string()),
  sections: z.array(z.object({
    sectionId: z.string(),
    title: z.string(),
    headingLevel: z.number().int().nonnegative(),
    chunkIds: z.array(z.string()),
  })),
  chunks: z.array(z.object({
    chunkId: z.string(),
    chunkType: z.string(),
    resourceId: z.string().nullable(),
    textExcerpt: z.string().nullable(),
  })),
  resourceIds: z.array(z.string()),
  tokenTableIds: z.array(z.string()),
  unsupportedChunkTypes: z.array(z.string()),
});

const RawSummaryArtifactSchema = z.object({
  artifactId: z.string(),
  kind: z.string(),
  sourceUrl: z.string(),
  sha256: z.string(),
  fetchedAt: z.string(),
  httpStatus: z.number().int().nullable(),
});

export const GetPageOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  found: z.boolean(),
  view: z.union([z.literal('structured'), z.literal('markdown'), z.literal('raw-summary')]),
  route: z.string(),
  structured: StructuredPageSchema.optional(),
  markdown: z.object({
    meta: z.object({}).passthrough(),
    markdown: z.string(),
  }).optional(),
  rawSummary: z.object({
    artifacts: z.array(RawSummaryArtifactSchema),
    sourceRoute: z.string().nullable(),
    canonicalRoute: z.string().nullable(),
    virtualRoute: z.string().nullable(),
  }).optional(),
});

export const GetComponentOverviewOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  component: z.string(),
  found: z.boolean(),
  canonicalName: z.string().nullable(),
  componentSlug: z.string().nullable(),
  routes: z.array(z.object({
    route: z.string(),
    title: z.string().nullable(),
    coverageStatus: z.string(),
    hasStructuredPage: z.boolean(),
  })),
  tabs: z.array(z.object({ label: z.string(), route: z.string() })),
  tokenTables: z.array(z.object({
    resourceId: z.string(),
    resourceName: z.string().nullable(),
    tokenSetCount: z.number().int().nonnegative(),
    tokenCount: z.number().int().nonnegative(),
    unresolvedTokenCount: z.number().int().nonnegative(),
  })),
  resourceCounts: z.object({
    'token-table': z.number().int().nonnegative(),
    'status-table': z.number().int().nonnegative(),
    image: z.number().int().nonnegative(),
    video: z.number().int().nonnegative(),
    'unknown-resource': z.number().int().nonnegative(),
  }),
  recommendedRoutes: z.array(z.string()),
});

export const GetComponentTokensOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  component: z.string(),
  found: z.boolean(),
  tokenTables: z.array(TokenTableNodeSchema),
});

export const GetComponentTabsOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  component: z.string(),
  found: z.boolean(),
  routes: z.array(z.object({ route: z.string(), tabs: z.array(RouteTabNodeSchema) })),
});

export const GetComponentResourcesOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  component: z.string(),
  found: z.boolean(),
  resources: z.array(ResourceNodeSchema),
});

export const GetRouteArtifactsOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  found: z.boolean(),
  route: z.string(),
  artifacts: z.array(RawSummaryArtifactSchema),
});

export const GetRawArtifactOutputSchema = z.object({
  found: z.boolean(),
  message: MessageSchema,
  artifact: z.object({}).passthrough().nullable(),
  content: z.string().nullable(),
  truncated: z.boolean(),
});

export const ExplainObjectOutputSchema = z.object({}).passthrough();

export const SearchStructuredDocsOutputSchema = z.object({
  available: z.boolean(),
  message: MessageSchema,
  query: z.string(),
  results: z.array(z.object({
    kind: z.union([
      z.literal('route'),
      z.literal('page'),
      z.literal('section'),
      z.literal('chunk'),
      z.literal('token'),
      z.literal('resource'),
    ]),
    route: z.string().nullable(),
    title: z.string(),
    excerpt: z.string(),
    tokenSetName: z.string().optional(),
    tokenName: z.string().optional(),
    resourceId: z.string().optional(),
  })),
});
