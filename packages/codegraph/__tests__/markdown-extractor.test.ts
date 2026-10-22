import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';

// The Markdown extractor puts documentation into the graph: a file node, a
// section node per heading nested by contains edges, and documents references
// to the code the prose names. Everything here goes through the public
// extractFromSource, so the .md extension mapping and the extractor dispatch
// are covered with it. (docs/plans/graph.md, step 1.)

const FILE = 'docs/design.md';

const extract = (md: string) => extractFromSource(FILE, md);

const sections = (md: string) => extract(md).nodes.filter((n) => n.kind === 'section');

const refNames = (md: string) =>
  extract(md).unresolvedReferences.map((r) => r.referenceName);

describe('Markdown extractor - document structure', () => {
  it('emits a markdown file node spanning the document', () => {
    const file = extract('# Title\n\nbody\n').nodes.find((n) => n.kind === 'file');
    expect(file?.language).toBe('markdown');
    expect(file?.startLine).toBe(1);
    expect(file?.endLine).toBe(4);
  });

  it('nests headings by level through contains edges', () => {
    const result = extract('# Storage\n\n## Writer\n\n### Batching\n\n## Reader\n');
    const byName = new Map(
      result.nodes.filter((n) => n.kind === 'section').map((n) => [n.name, n])
    );
    expect([...byName.keys()]).toEqual(['Storage', 'Writer', 'Batching', 'Reader']);

    const contains = result.edges.filter((e) => e.kind === 'contains');
    const parentOf = (name: string) => {
      const edge = contains.find((e) => e.target === byName.get(name)!.id)!;
      return result.nodes.find((n) => n.id === edge.source)!;
    };
    expect(parentOf('Writer').name).toBe('Storage');
    expect(parentOf('Batching').name).toBe('Writer');
    expect(parentOf('Reader').name).toBe('Storage');
    expect(parentOf('Storage').kind).toBe('file');
  });

  it('qualifies a section by its heading path under the document', () => {
    expect(sections('# Storage\n\n## Writer\n').map((s) => s.qualifiedName)).toEqual([
      'docs/design.md#Storage',
      'docs/design.md#Storage#Writer',
    ]);
  });

  it('closes a section at the next heading of its level or above', () => {
    const found = sections('# One\n\na\n\n## Two\n\nb\n\n# Three\n\nc\n');
    const range = (name: string) => {
      const s = found.find((n) => n.name === name)!;
      return [s.startLine, s.endLine];
    };
    expect(range('One')).toEqual([1, 8]);
    expect(range('Two')).toEqual([5, 8]);
    expect(range('Three')).toEqual([9, 12]);
  });

  it('reads setext headings, anchored on the title rather than its underline', () => {
    const found = sections('Storage\n=======\n\nWriter\n------\n\nbody\n');
    expect(found.map((s) => s.name)).toEqual(['Storage', 'Writer']);
    expect(found.map((s) => s.startLine)).toEqual([1, 4]);
    expect(found[1]!.qualifiedName).toBe('docs/design.md#Storage#Writer');
  });
});

describe('Markdown extractor - fenced code', () => {
  const md = [
    '# Title',
    '',
    '```ts',
    '# Not a heading',
    '`insideFence` and [ghost](./ghost.md)',
    '```',
    '',
    'Use `outsideFence` and [design](./other.md).',
    '',
  ].join('\n');

  it('reads no heading from inside a fence', () => {
    expect(sections(md).map((s) => s.name)).toEqual(['Title']);
  });

  it('reads no reference from inside a fence, but still reads the prose around it', () => {
    const names = refNames(md);
    expect(names).not.toContain('insideFence');
    expect(names).not.toContain('ghost.md');
    expect(names).toContain('outsideFence');
    expect(names).toContain('other.md');
  });
});

describe('Markdown extractor - references', () => {
  it('takes a code span only when it names a symbol or a path', () => {
    const md =
      '# API\n\nCall `parseFile()` in `src/db/queries.ts`; ' +
      'run `npm run check:fast` with `--deny-tool`.\n';
    expect(refNames(md)).toEqual(['parseFile', 'src/db/queries.ts']);
  });

  it('takes a link target in the project, and leaves external links and anchors alone', () => {
    const md =
      '# Links\n\n[design](./design.md), [site](https://example.com/page.md), ' +
      '[here](#links), [code](../src/db/queries.ts#L10)\n';
    expect(refNames(md)).toEqual(['design.md', '../src/db/queries.ts']);
  });

  it('takes a link reference definition', () => {
    expect(refNames('# D\n\nSee [the writer][w].\n\n[w]: ./writer.md\n')).toEqual([
      'writer.md',
    ]);
  });

  it('records one reference for a name repeated on a line', () => {
    expect(refNames('# D\n\n`dup` and `dup`\n')).toEqual(['dup']);
  });

  it('attributes a reference to the innermost section, or to the file above the first heading', () => {
    const result = extract('Intro mentions `rootSymbol`.\n\n# Storage\n\n## Writer\n\nSee `writeBatch`.\n');
    const fileId = result.nodes.find((n) => n.kind === 'file')!.id;
    const writerId = result.nodes.find((n) => n.name === 'Writer')!.id;
    const from = (name: string) =>
      result.unresolvedReferences.find((r) => r.referenceName === name)!;

    expect(from('rootSymbol').fromNodeId).toBe(fileId);
    expect(from('writeBatch').fromNodeId).toBe(writerId);
  });

  it('records doc references as documents, in markdown', () => {
    const [ref] = extract('# D\n\nSee `parseFile`.\n').unresolvedReferences;
    expect(ref?.referenceKind).toBe('documents');
    expect(ref?.language).toBe('markdown');
    expect(ref?.line).toBe(3);
  });
});
