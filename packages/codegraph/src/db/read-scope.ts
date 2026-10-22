/**
 * A read scope: one tool call's single-row reads, remembered.
 *
 * CodeGraph's tool handlers read the graph item by item (a node's edges, a
 * file's nodes, a file record), and many items more than once; on DuckDB each
 * such read is a query. While a scope is open, QueryBuilder answers them from
 * here: a read the scope holds costs nothing, a miss is fetched and kept, and
 * a handler can fill the scope for its whole working set first
 * (QueryBuilder.prefetchNeighbourhood) with one query per kind of read
 * (packages/codegraph-store/DESIGN.md, Set-based reads). Every read checks
 * the index's change stamp first, and a change from anywhere empties the
 * scope, so it never answers from an index that has moved on.
 */

import type { Edge, FileRecord, Node } from '../types';

type Direction = 'outgoing' | 'incoming';

export interface ScopeFetchers {
  stamp(): string;
  edges(ids: readonly string[], direction: Direction): Map<string, Edge[]>;
  nodes(ids: readonly string[]): Map<string, Node>;
  nodesInFiles(paths: readonly string[]): Map<string, Node[]>;
  files(paths: readonly string[]): Map<string, FileRecord | null>;
  named(names: readonly string[]): Map<string, Node[]>;
  containing(substrings: readonly string[]): Map<string, Array<{ node: Node; startsWith: boolean }>>;
}

export class ReadScope {
  private stampSeen: string;
  private readonly edgesOf: Record<Direction, Map<string, Edge[]>> = { outgoing: new Map(), incoming: new Map() };
  private readonly nodeOf = new Map<string, Node | null>();
  private readonly fileNodes = new Map<string, Node[]>();
  private readonly fileOf = new Map<string, FileRecord | null>();
  private readonly nodesNamed = new Map<string, Node[]>();
  private readonly substringHits = new Map<string, Array<{ node: Node; startsWith: boolean }>>();

  constructor(private readonly fetch: ScopeFetchers) {
    this.stampSeen = fetch.stamp();
  }

  /** Empties the scope if the index changed since it last looked. */
  private fresh(): void {
    const stamp = this.fetch.stamp();
    if (stamp === this.stampSeen) return;
    this.stampSeen = stamp;
    this.edgesOf.outgoing.clear();
    this.edgesOf.incoming.clear();
    this.nodeOf.clear();
    this.fileNodes.clear();
    this.fileOf.clear();
    this.nodesNamed.clear();
    this.substringHits.clear();
  }

  /** Every node whose name holds `substring`, with whether it starts with it (QueryBuilder.getNodesBySubstrings). */
  containing(substring: string): Array<{ node: Node; startsWith: boolean }> {
    this.fresh();
    this.fillContaining([substring]);
    return this.substringHits.get(substring)!;
  }

  private fillContaining(substrings: readonly string[]): void {
    const missing = [...new Set(substrings)].filter((s) => !this.substringHits.has(s));
    if (missing.length === 0) return;
    for (const [s, hits] of this.fetch.containing(missing)) this.substringHits.set(s, hits);
  }

  /** The nodes named exactly `name`, in getNodesByName's order. */
  named(name: string): Node[] {
    this.fresh();
    this.fillNamed([name]);
    return this.nodesNamed.get(name)!;
  }

  private fillNamed(names: readonly string[]): void {
    const missing = [...new Set(names)].filter((n) => !this.nodesNamed.has(n));
    if (missing.length === 0) return;
    for (const [name, nodes] of this.fetch.named(missing)) this.nodesNamed.set(name, nodes);
  }

  /** Every edge out of (into) `id`, in getOutgoingEdges' (getIncomingEdges') order. */
  edges(id: string, direction: Direction): Edge[] {
    this.fresh();
    this.fillEdges([id], direction);
    return this.edgesOf[direction].get(id)!;
  }

  node(id: string): Node | null {
    this.fresh();
    this.fillNodes([id]);
    return this.nodeOf.get(id) ?? null;
  }

  nodesInFile(path: string): Node[] {
    this.fresh();
    if (!this.fileNodes.has(path)) for (const [p, nodes] of this.fetch.nodesInFiles([path])) this.fileNodes.set(p, nodes);
    return this.fileNodes.get(path)!;
  }

  file(path: string): FileRecord | null {
    this.fresh();
    if (!this.fileOf.has(path)) for (const [p, record] of this.fetch.files([path])) this.fileOf.set(p, record);
    return this.fileOf.get(path) ?? null;
  }

  /** Every edge of each of `ids` in `direction`, from the scope where it holds them. */
  edgesMany(ids: readonly string[], direction: Direction): Map<string, Edge[]> {
    this.fresh();
    this.fillEdges(ids, direction);
    return new Map(ids.map((id) => [id, this.edgesOf[direction].get(id)!.slice()]));
  }

  /** The nodes of `ids` that exist, from the scope where it holds them. */
  nodesMany(ids: readonly string[]): Map<string, Node> {
    this.fresh();
    this.fillNodes(ids);
    const out = new Map<string, Node>();
    for (const id of ids) {
      const node = this.nodeOf.get(id);
      if (node) out.set(id, node);
    }
    return out;
  }

  /**
   * Reads a handler is about to make for a whole set, each in one query:
   * `edges` in the directions given, `nodes`, `fileNodes` (a file's nodes)
   * and `files` (file records).
   */
  prefetchSets(sets: {
    edges?: { ids: readonly string[]; directions: readonly Direction[] };
    nodes?: readonly string[];
    fileNodes?: readonly string[];
    files?: readonly string[];
    names?: readonly string[];
    substrings?: readonly string[];
  }): void {
    this.fresh();
    if (sets.names) this.fillNamed(sets.names);
    if (sets.substrings) this.fillContaining(sets.substrings);
    for (const direction of sets.edges?.directions ?? []) this.fillEdges(sets.edges!.ids, direction);
    if (sets.nodes) this.fillNodes(sets.nodes);
    const fileNodes = [...new Set(sets.fileNodes ?? [])].filter((p) => !this.fileNodes.has(p));
    if (fileNodes.length > 0) for (const [p, nodes] of this.fetch.nodesInFiles(fileNodes)) this.fileNodes.set(p, nodes);
    const files = [...new Set(sets.files ?? [])].filter((p) => !this.fileOf.has(p));
    if (files.length > 0) for (const [p, record] of this.fetch.files(files)) this.fileOf.set(p, record);
  }

  /**
   * Fills the scope with the neighbourhood a loop of traversals from `ids`
   * will read, `depth` levels out in `directions`: per level, the whole
   * frontier's edges in one query per direction and their far ends' nodes in
   * one, so each traversal in the loop reads from memory. Every frontier
   * node is expanded, busy ones too: skipping nodes with over 100 edges was
   * tried and cost more, as the traversals then read those edges one node at
   * a time. Stops adding levels once `budget` nodes are held; what it didn't
   * fetch is read on demand as before.
   */
  prefetchReach(ids: readonly string[], directions: readonly Direction[], depth: number, budget = 5000): void {
    this.fresh();
    let frontier = [...new Set(ids)];
    const seen = new Set(frontier);
    this.fillNodes(frontier);
    for (let level = 0; level < depth && frontier.length > 0 && this.nodeOf.size < budget; level++) {
      const next: string[] = [];
      for (const direction of directions) {
        this.fillEdges(frontier, direction);
        for (const id of frontier) {
          for (const edge of this.edgesOf[direction].get(id)!) {
            const far = direction === 'outgoing' ? edge.target : edge.source;
            if (!seen.has(far)) {
              seen.add(far);
              next.push(far);
            }
          }
        }
      }
      this.fillNodes(next);
      frontier = next;
    }
  }

  /** Fills the scope for `ids`: their edges both ways and the nodes at both ends. */
  prefetch(ids: readonly string[]): void {
    this.fresh();
    this.fillNodes(ids);
    this.fillEdges(ids, 'outgoing');
    this.fillEdges(ids, 'incoming');
    const far = new Set<string>();
    for (const id of ids) {
      for (const edge of this.edgesOf.outgoing.get(id)!) far.add(edge.target);
      for (const edge of this.edgesOf.incoming.get(id)!) far.add(edge.source);
    }
    this.fillNodes([...far]);
  }

  private fillEdges(ids: readonly string[], direction: Direction): void {
    const missing = [...new Set(ids)].filter((id) => !this.edgesOf[direction].has(id));
    if (missing.length === 0) return;
    for (const [id, edges] of this.fetch.edges(missing, direction)) this.edgesOf[direction].set(id, edges);
  }

  private fillNodes(ids: readonly string[]): void {
    const missing = [...new Set(ids)].filter((id) => !this.nodeOf.has(id));
    if (missing.length === 0) return;
    const found = this.fetch.nodes(missing);
    for (const id of missing) this.nodeOf.set(id, found.get(id) ?? null);
  }
}
