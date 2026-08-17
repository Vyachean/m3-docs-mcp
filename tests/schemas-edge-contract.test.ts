import { describe, expect, it } from 'vitest';
import {
  ContentChunkSchema,
  ResourceChunkSchema,
  TokenTableSystemSchema,
  parseContentPage,
  parseStatusTable
} from '../src/json-extraction/schemas.js';

describe('TokenTableSystemSchema edge contract', () => {
  it('preserves context groups and recursively decoded reference trees', () => {
    const decoded = TokenTableSystemSchema.parse({
      tokens: [
        {
          name: 'token-1',
          tokenName: 'md.comp.example.color',
          displayName: 'Example color',
          tokenValueType: 'COLOR',
          state: 'ACTIVE'
        }
      ],
      tokenSets: [
        {
          name: 'set-1',
          displayName: 'Example - Color',
          tokenSetName: 'md.comp.example'
        }
      ],
      tags: [
        { name: 'tag-light', displayName: 'Light', tagName: 'light' }
      ],
      contextTagGroups: [
        { name: 'theme-group', displayName: 'Theme', defaultTag: 'tag-light' }
      ],
      contextualReferenceTrees: {
        'token-1': {
          contextualReferenceTree: [
            {
              contextTags: ['tag-light'],
              referenceTree: {
                tokenName: 'md.comp.example.color',
                childNodes: [
                  { tokenName: 'md.sys.color.primary', childNodes: [] }
                ]
              },
              resolvedValue: { color: { red: 1, green: 0, blue: 0 } }
            },
            {
              contextTags: 'invalid',
              referenceTree: null,
              resolvedValue: null
            }
          ]
        },
        invalidEntry: null
      }
    });

    expect(decoded.contextTagGroups).toEqual([
      { name: 'theme-group', displayName: 'Theme', defaultTag: 'tag-light' }
    ]);
    expect(decoded.contextualReferenceTrees['token-1']).toEqual({
      contextualReferenceTree: [
        {
          contextTags: ['tag-light'],
          referenceTree: {
            tokenName: 'md.comp.example.color',
            childNodes: [
              { tokenName: 'md.sys.color.primary', childNodes: [] }
            ]
          },
          resolvedValue: { color: { red: 1, green: 0, blue: 0 } }
        },
        {
          contextTags: [],
          referenceTree: { tokenName: '', childNodes: [] },
          resolvedValue: {}
        }
      ]
    });
    expect(decoded.contextualReferenceTrees.invalidEntry).toBeUndefined();
  });
});

describe('raw chunk schemas', () => {
  it('ContentChunkSchema preserves every supported alias and passthrough data', () => {
    const raw = {
      contentChunkType: 'VIDEO',
      type: 'video-alias',
      kind: 'kind-alias',
      htmlValue: '<p>htmlValue</p>',
      html: '<p>html</p>',
      value: 'value',
      body: 'body',
      imageUrl: 'image-url',
      url: 'url',
      src: 'src',
      altText: 'altText',
      alt: 'alt',
      title: 'title',
      footer: 'footer',
      caption: 'caption',
      captionText: 'captionText',
      videoUrl: 'video-url',
      embedUrl: 'embed-url',
      description: 'description',
      libraryModuleType: 'TOKEN_TABLE',
      moduleType: 'module-type',
      resourceType: 'resource-type',
      resourceName: 'resource-name',
      resourcePath: 'resource-path',
      resourceUrl: 'resource-url',
      moduleConfigurationOverrides: { arbitrary: true },
      moduleConfiguration: { other: true },
      tokenSets: ['Set'],
      futureField: { preserved: true }
    };

    expect(ContentChunkSchema.parse(raw)).toEqual(raw);
  });

  it('ResourceChunkSchema accepts explicit null configurations and preserves extension fields', () => {
    const raw = {
      libraryModuleType: 'STATUS_TABLE',
      moduleType: 'module-type',
      resourceType: 'resource-type',
      resourceName: 'resource-name',
      resourcePath: 'resource-path',
      resourceUrl: 'resource-url',
      moduleConfigurationOverrides: null,
      moduleConfiguration: null,
      tokenSets: ['Set'],
      futureField: 'preserved'
    };

    expect(ResourceChunkSchema.parse(raw)).toEqual(raw);
  });

  it('ResourceChunkSchema keeps typed configuration values and passthrough keys', () => {
    const decoded = ResourceChunkSchema.parse({
      libraryModuleType: null,
      moduleType: null,
      resourceType: null,
      resourceName: null,
      resourcePath: null,
      resourceUrl: null,
      moduleConfigurationOverrides: {
        tokenSets: ['Override'],
        resourceName: 'override-resource',
        extra: 1
      },
      moduleConfiguration: {
        tokenSets: ['Configuration'],
        resourceName: 'configuration-resource',
        extra: 2
      }
    });

    expect(decoded.moduleConfigurationOverrides).toEqual({
      tokenSets: ['Override'],
      resourceName: 'override-resource',
      extra: 1
    });
    expect(decoded.moduleConfiguration).toEqual({
      tokenSets: ['Configuration'],
      resourceName: 'configuration-resource',
      extra: 2
    });
  });
});

describe('parseStatusTable edge contract', () => {
  it('keeps partially populated rows instead of requiring every cell to be truthy', () => {
    expect(parseStatusTable({
      headers: ['Platform', 'Status'],
      rows: [
        ['', 'Available'],
        ['Android', ''],
        ['', ''],
        ['Web', 'Stable']
      ]
    })).toEqual({
      headers: ['Platform', 'Status'],
      rows: [
        ['', 'Available'],
        ['Android', ''],
        ['Web', 'Stable']
      ]
    });
  });

  it('decodes nested connection matrices, default ordering, links, and status labels', () => {
    expect(parseStatusTable({
      payload: {
        connections: [
          { displayName: 'Default order', status: 'IN_PROGRESS' },
          { displayName: 'First', status: 'NOT_AVAILABLE', orderInComponent: 1 },
          {
            displayName: 'Second',
            status: 'AVAILABLE',
            resourceUrl: 'https://example.test/second',
            orderInComponent: 2
          },
          { displayName: 42, status: 'AVAILABLE', orderInComponent: 0 },
          { displayName: 'Missing status', orderInComponent: 0 },
          null
        ]
      }
    })).toEqual({
      headers: ['Platform', 'Status'],
      rows: [
        ['First', 'Not available'],
        ['[Second](https://example.test/second)', 'Available'],
        ['Default order', 'In progress']
      ]
    });
  });

  it('stable-stringifies nested non-string row values deterministically', () => {
    expect(parseStatusTable({
      headers: ['Value', 'More'],
      rows: [
        [
          { z: [3, { b: 2, a: 1 }], a: true },
          ['x', { z: 2, a: 1 }]
        ]
      ]
    })).toEqual({
      headers: ['Value', 'More'],
      rows: [
        [
          '{"a":true,"z":[3,{"a":1,"b":2}]}',
          '["x",{"a":1,"z":2}]'
        ]
      ]
    });
  });
});

describe('parseContentPage alias contract', () => {
  it.each([
    ['sections', { sections: [{ name: 'Direct', blocks: [] }] }],
    ['content.sections', { content: { sections: [{ name: 'Content', blocks: [] }] } }],
    ['page.sections', { page: { sections: [{ name: 'Page', blocks: [] }] } }],
    ['data.sections', { data: { sections: [{ name: 'Data', blocks: [] }] } }]
  ])('reads %s as a canonical direct section path', (_label, raw) => {
    expect(parseContentPage(raw).sections).toHaveLength(1);
  });

  it('honors section/block aliases, title precedence, defaults, and both visibility flags', () => {
    const decoded = parseContentPage({
      page: {
        sections: [
          {
            name: 'Name wins',
            title: 'Title loses',
            heading: 'Heading loses',
            blocks: [
              {
                title: 'Block title',
                name: 'Block name',
                heading: 'Block heading',
                chunks: [{ type: 'TEXT', value: 'one' }]
              }
            ]
          },
          {
            title: 'Title fallback',
            content: [
              {
                name: 'Block name',
                content: [{ kind: 'TEXT', body: 'two' }]
              }
            ]
          },
          {
            heading: 'Heading fallback',
            items: [
              {
                heading: 'Block heading',
                items: [{ html: '<p>three</p>' }]
              }
            ]
          },
          { blocks: [] },
          { name: 'Hidden by visible', visible: false, blocks: [] },
          { name: 'Hidden by isVisible', isVisible: false, blocks: [] }
        ]
      }
    });

    expect(decoded.sections.map((section) => section.title)).toEqual([
      'Name wins',
      'Title fallback',
      'Heading fallback',
      'Section'
    ]);
    expect(decoded.sections[0]?.blocks[0]).toEqual({
      title: 'Block title',
      chunks: [expect.objectContaining({ type: 'TEXT', value: 'one' })]
    });
    expect(decoded.sections[1]?.blocks[0]).toEqual({
      title: 'Block name',
      chunks: [expect.objectContaining({ kind: 'TEXT', body: 'two' })]
    });
    expect(decoded.sections[2]?.blocks[0]).toEqual({
      title: 'Block heading',
      chunks: [expect.objectContaining({ html: '<p>three</p>' })]
    });
  });

  it('drops both hidden block flags, malformed blocks, and malformed chunks', () => {
    const decoded = parseContentPage({
      sections: [
        {
          name: 'Visible',
          contentBlocks: [
            { title: 'Hidden isHidden', isHidden: true, contentChunks: [{ value: 'hidden' }] },
            { title: 'Hidden hidden', hidden: true, contentChunks: [{ value: 'hidden' }] },
            null,
            {
              title: 'Visible block',
              contentChunks: [
                null,
                42,
                { contentChunkType: 'TEXT', htmlValue: '<p>visible</p>' }
              ]
            }
          ]
        }
      ]
    });

    expect(decoded.sections).toEqual([
      {
        title: 'Visible',
        blocks: [
          {
            title: 'Visible block',
            chunks: [expect.objectContaining({ contentChunkType: 'TEXT', htmlValue: '<p>visible</p>' })]
          }
        ]
      }
    ]);
  });

  it('discovers mixed nested arrays when at least one entry is section-like', () => {
    const decoded = parseContentPage({
      wrapper: {
        arbitrary: [
          42,
          { heading: 'Discovered', blocks: [] }
        ]
      }
    });

    expect(decoded.sections).toEqual([
      { title: 'Discovered', blocks: [] }
    ]);
  });

  it('recognizes chunk-shaped entries during nested section discovery', () => {
    const decoded = parseContentPage({
      wrapper: {
        arbitrary: [
          { heading: 'Content chunks', contentChunks: [{ value: 'text' }] },
          { heading: 'Chunks', chunks: [{ value: 'text' }] }
        ]
      }
    });

    expect(decoded.sections).toEqual([
      { title: 'Content chunks', blocks: [] },
      { title: 'Chunks', blocks: [] }
    ]);
  });
});
