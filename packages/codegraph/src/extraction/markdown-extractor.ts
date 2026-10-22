import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { NodeIdAllocator } from './tree-sitter-helpers';

/**
 * MarkdownExtractor - puts documentation into the code graph.
 *
 * Markdown has no symbols of its own, so what is extracted is the document's
 * structure and the deterministic references its text makes to code:
 * - the file node for the document, and a `section` node per heading, nested
 *   by heading level through `contains` edges;
 * - `documents` references from the innermost section (or the file, above the
 *   first heading) to the symbols, files and other documents its text names.
 *
 * Only two shapes are read as references, because only they are unambiguous:
 * inline code spans (`foo()`, `Class.method`, `src/thing.ts`) and link
 * targets (`[text](./design.md)`, and reference definitions). Prose words and
 * fenced example blocks are not mined: a fenced block is illustration, not a
 * statement about this project's code, and prose produces false links.
 *
 * A reference that resolves becomes an edge. One that does not stays an
 * unresolved reference — a document naming a symbol that no longer exists is
 * a drift finding, not something to discard.
 */

/** Inline code spans and link targets harvested per document. */
const MAX_REFERENCES_PER_FILE = 2000;

/** Heading nesting beyond this is treated as flat; Markdown allows 1-6. */
const MAX_HEADING_LEVEL = 6;

/** A code span that is a symbol name: `foo`, `Foo.bar`, `a::b`, `foo()`. */
const SYMBOL_SPAN = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#|->)[A-Za-z_$][\w$]*)*(?:\(\s*\))?$/;

/** A code span (or link target) that names a file: `src/a.ts`, `README.md`. */
const PATH_SPAN = /^[\w.@~-]+(?:\/[\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,8}$/;

/** Link targets that leave the project: no file node can exist for them. */
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export class MarkdownExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private nodeIds = new NodeIdAllocator();
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private seenReferences = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const lines = this.source.split('\n');
      const fileNode = this.createFileNode(lines);
      const sections = this.extractSections(lines, fileNode);
      this.extractReferences(lines, fileNode, sections);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(lines: string[]): Node {
    const fileNode: Node = {
      id: this.nodeIds.generate(this.filePath, 'file', this.filePath, 1, 0),
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * Every heading becomes a section node, closed by the next heading at its
   * own level or above. Both Markdown spellings are read: ATX (`## Title`)
   * and setext (a title underlined with `===` or `---`).
   */
  private extractSections(lines: string[], fileNode: Node): SectionRange[] {
    const open: SectionRange[] = [];
    const all: SectionRange[] = [];
    const fences = this.fencedLines(lines);

    const close = (level: number, endLine: number): void => {
      while (open.length > 0 && open[open.length - 1]!.level >= level) {
        open.pop()!.node.endLine = Math.max(endLine, 1);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      if (fences.has(i)) continue;
      const line = lines[i]!;
      let level = 0;
      let title = '';
      let column = 0;

      const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (atx) {
        level = atx[1]!.length;
        title = atx[2]!.trim();
        column = line.indexOf('#');
      } else {
        // Setext: the underline belongs to the line above, which must be text.
        const underline = /^[ \t]{0,3}(=+|-+)[ \t]*$/.exec(line);
        const previous = i > 0 ? lines[i - 1] : undefined;
        if (
          underline &&
          previous !== undefined &&
          !fences.has(i - 1) &&
          previous.trim().length > 0 &&
          !/^[ \t]{0,3}(?:[-*+>]|\d+[.)])[ \t]/.test(previous) &&
          !/^#{1,6}[ \t]/.test(previous)
        ) {
          level = underline[1]!.startsWith('=') ? 1 : 2;
          title = previous.trim();
          column = previous.length - previous.trimStart().length;
          // The heading starts on the title's line, not on its underline.
          const section = this.openSection(title, level, i, column, open, fileNode);
          open.push(section);
          all.push(section);
          continue;
        }
        continue;
      }

      if (title.length === 0 || level > MAX_HEADING_LEVEL) continue;
      const section = this.openSection(title, level, i + 1, column, open, fileNode);
      open.push(section);
      all.push(section);
    }

    close(0, lines.length);
    return all;
  }

  /**
   * `headingLine` is 1-based. A section's qualified name is its heading path
   * under the document (`docs/design.md#Storage#Writer`), so two sections with
   * the same title under different parents stay distinct.
   */
  private openSection(
    title: string,
    level: number,
    headingLine: number,
    column: number,
    open: SectionRange[],
    fileNode: Node
  ): SectionRange {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      open.pop()!.node.endLine = Math.max(headingLine - 1, 1);
    }
    const parent = open.length > 0 ? open[open.length - 1]! : null;
    const qualifiedName = parent
      ? `${parent.node.qualifiedName}#${title}`
      : `${this.filePath}#${title}`;

    const node: Node = {
      id: this.nodeIds.generate(this.filePath, 'section', qualifiedName, headingLine, column),
      kind: 'section',
      name: title,
      qualifiedName,
      filePath: this.filePath,
      language: 'markdown',
      startLine: headingLine,
      endLine: headingLine,
      startColumn: column,
      endColumn: column + title.length,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({
      source: parent ? parent.node.id : fileNode.id,
      target: node.id,
      kind: 'contains',
      line: headingLine,
    });
    return { node, level };
  }

  /**
   * Line indexes (0-based) inside fenced code blocks, fence lines included.
   * Everything in them is illustration, so no heading and no reference is read
   * from them.
   */
  private fencedLines(lines: string[]): Set<number> {
    const fenced = new Set<number>();
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const match = /^[ \t]{0,3}(```+|~~~+)/.exec(lines[i]!);
      if (fence === null) {
        if (match) {
          fence = match[1]!.charAt(0);
          fenced.add(i);
        }
        continue;
      }
      fenced.add(i);
      // A fence closes on a run of its own character, no info string after it.
      if (match && match[1]!.charAt(0) === fence && /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(lines[i]!)) {
        fence = null;
      }
    }
    return fenced;
  }

  /**
   * Inline code spans and link targets, attributed to the innermost section
   * containing them.
   */
  private extractReferences(lines: string[], fileNode: Node, sections: SectionRange[]): void {
    const fences = this.fencedLines(lines);
    for (let i = 0; i < lines.length; i++) {
      if (fences.has(i)) continue;
      const line = lines[i]!;
      const owner = this.sectionAt(i + 1, sections)?.node.id ?? fileNode.id;

      for (const span of line.matchAll(/(`+)([^`]+?)\1/g)) {
        this.addReference(owner, span[2]!.trim(), i + 1, span.index ?? 0);
      }
      // Inline links and images, then link reference definitions.
      for (const link of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        this.addLinkTarget(owner, link[1]!, i + 1, link.index ?? 0);
      }
      const definition = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(\S+)/.exec(line);
      if (definition) this.addLinkTarget(owner, definition[1]!, i + 1, 0);
    }
  }

  /** The innermost section whose range covers `line` (1-based). */
  private sectionAt(line: number, sections: SectionRange[]): SectionRange | null {
    let best: SectionRange | null = null;
    for (const section of sections) {
      if (line < section.node.startLine || line > section.node.endLine) continue;
      if (!best || section.level > best.level) best = section;
    }
    return best;
  }

  /**
   * A link target naming something in the project. External targets (a URL,
   * a protocol-relative link) and bare anchors are not references to code.
   */
  private addLinkTarget(fromNodeId: string, rawTarget: string, line: number, column: number): void {
    let target = rawTarget.trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (target.length === 0 || target.startsWith('#') || EXTERNAL_TARGET.test(target)) return;
    const withoutAnchor = target.split('#')[0]!;
    if (withoutAnchor.length === 0) return;
    this.addReference(fromNodeId, withoutAnchor, line, column);
  }

  /**
   * One reference, if the text is a shape that names code: a symbol, or a
   * path. Anything else — prose in backticks, a command line, a flag — is
   * left alone rather than guessed at.
   */
  private addReference(fromNodeId: string, text: string, line: number, column: number): void {
    if (this.unresolvedReferences.length >= MAX_REFERENCES_PER_FILE) return;
    if (text.length === 0 || text.length > 200) return;

    let name = text;
    if (PATH_SPAN.test(name)) {
      // Keep the path as written, minus a leading `./`, so the resolver's
      // path matching sees the same shape a Liquid or C include gives it.
      name = name.replace(/^\.\//, '');
    } else if (SYMBOL_SPAN.test(name)) {
      name = name.replace(/\(\s*\)$/, '');
    } else {
      return;
    }

    const key = `${fromNodeId}|${name}|${line}`;
    if (this.seenReferences.has(key)) return;
    this.seenReferences.add(key);

    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: name,
      referenceKind: 'documents',
      line,
      column,
      filePath: this.filePath,
      language: 'markdown',
    });
  }
}

/** A heading's node and its level, while its range is still open. */
interface SectionRange {
  node: Node;
  level: number;
}
