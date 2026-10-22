/**
 * A traversal's reads, a frontier at a time.
 *
 * The traversals in traversal.ts walk the graph node by node, and asked the
 * database for each node's edges and neighbours one node at a time: on
 * DuckDB a query each, hundreds for one impact radius. A Neighbourhood
 * serves those same reads from what it fetched for a whole frontier in one
 * query (packages/codegraph-store/DESIGN.md, Set-based reads): `expand`
 * walks out from the start a hop at a time, reading every frontier node's
 * edges and their far ends together, so the traversal's own loop, its
 * limits and its order stay exactly as they were. A read it didn't prefetch
 * falls back to the database, so a prefetch that stops early only costs
 * queries. It lives for one traversal call: the graph may change between
 * calls.
 */

import { Node, Edge, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

type Direction = 'outgoing' | 'incoming';

export class Neighbourhood {
  private readonly edgesOf: Record<Direction, Map<string, Edge[]>> = { outgoing: new Map(), incoming: new Map() };
  private readonly nodes = new Map<string, Node | null>();

  constructor(private readonly queries: QueryBuilder) {}

  /**
   * Prefetches the part of the graph a traversal from `start` can reach in
   * `levels` levels, a frontier at a time: every frontier node's edges in
   * `directions` in one query, then their far ends' nodes in one. `step`
   * says what following an edge from node `from` costs, as the traversal
   * counts depth: 1 (the next level), 0 (the same level, as impact radius
   * enters a container's members) or null (not followed). Stops once
   * `budget` nodes are held (a traversal with a node limit never needs
   * more than about that).
   */
  expand(
    start: readonly string[],
    directions: readonly Direction[],
    levels: number,
    step: (edge: Edge, direction: Direction, from: Node | undefined) => 0 | 1 | null = () => 1,
    budget = Infinity
  ): void {
    const reached = new Set<string>();
    let level = [...new Set(start)];
    for (let depth = 0; depth < levels && level.length > 0 && this.nodes.size < budget; depth++) {
      const next = new Set<string>();
      // A level grows by its own cost-0 steps before the next level starts.
      let pending = level.filter((id) => !reached.has(id));
      while (pending.length > 0 && this.nodes.size < budget) {
        for (const id of pending) reached.add(id);
        const from = this.nodesByIds(pending);
        const same = new Set<string>();
        for (const direction of directions) {
          this.fetchEdges(pending, direction);
          for (const id of pending) {
            for (const edge of this.edgesOf[direction].get(id)!) {
              const cost = step(edge, direction, from.get(id));
              if (cost === null) continue;
              const far = direction === 'outgoing' ? edge.target : edge.source;
              if (reached.has(far)) continue;
              (cost === 0 ? same : next).add(far);
            }
          }
        }
        pending = [...same];
      }
      level = [...next].filter((id) => !reached.has(id));
    }
    // The last level's nodes are read (as neighbours) but not expanded.
    this.nodesByIds(level);
  }

  /** queries.getOutgoingEdges, from the prefetch where it has them. */
  outgoing(nodeId: string, kinds?: readonly EdgeKind[]): Edge[] {
    return this.edges(nodeId, 'outgoing', kinds);
  }

  /** queries.getIncomingEdges, from the prefetch where it has them. */
  incoming(nodeId: string, kinds?: readonly EdgeKind[]): Edge[] {
    return this.edges(nodeId, 'incoming', kinds);
  }

  /** queries.getNodeById, from the prefetch where it has it. */
  node(id: string): Node | null {
    return this.nodesByIds([id]).get(id) ?? null;
  }

  /** queries.getNodesByIds, from the prefetch where it has them. */
  nodesByIds(ids: readonly string[]): Map<string, Node> {
    const missing = [...new Set(ids)].filter((id) => !this.nodes.has(id));
    if (missing.length > 0) {
      const found = this.queries.getNodesByIds(missing);
      for (const id of missing) this.nodes.set(id, found.get(id) ?? null);
    }
    const out = new Map<string, Node>();
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) out.set(id, node);
    }
    return out;
  }

  private edges(nodeId: string, direction: Direction, kinds?: readonly EdgeKind[]): Edge[] {
    this.fetchEdges([nodeId], direction);
    const all = this.edgesOf[direction].get(nodeId)!;
    // The kind filter in memory keeps the order the filtered query gave:
    // both sort by kind, then the other end, line and column.
    return kinds && kinds.length > 0 ? all.filter((edge) => kinds.includes(edge.kind)) : all.slice();
  }

  private fetchEdges(ids: readonly string[], direction: Direction): void {
    const missing = ids.filter((id) => !this.edgesOf[direction].has(id));
    if (missing.length === 0) return;
    for (const [id, edges] of this.queries.getEdgesByNode(missing, direction)) this.edgesOf[direction].set(id, edges);
  }
}
