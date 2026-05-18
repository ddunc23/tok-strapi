/**
 * A set of functions called "actions" for `graph`
 */

/** BFS up to `maxDepth` hops; returns the count of unique reachable neighbours (excluding the seed). */
function egoNetworkSize(
  seed: string,
  adjacency: Map<string, Set<string>>,
  maxDepth: number,
): number {
  const visited = new Set<string>([seed]);
  let frontier = [seed];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited.size - 1; // exclude seed itself
}

export default {
  topNodes: async (ctx) => {
    try {
      const requestedLimit = Number.parseInt(String(ctx.query.limit ?? '100'), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;

      const egoDepth = 3;

      const relations = await strapi.db.query('api::relation.relation').findMany({
        where: {
          maker_extended: {
            id: {
              $notNull: true,
            },
          },
          target_maker_extended: {
            id: {
              $notNull: true,
            },
          },
        },
        populate: {
          maker_extended: true,
          target_maker_extended: true,
          relation_type: true,
        },
      });

      const makersByDocumentId = new Map<string, any>();
      const adjacency = new Map<string, Set<string>>();
      const validRelations = [];

      const addEdge = (a: string, b: string) => {
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());
        adjacency.get(a)!.add(b);
        adjacency.get(b)!.add(a);
      };

      for (const relation of relations) {
        const sourceMaker = relation.maker_extended;
        const targetMaker = relation.target_maker_extended;

        if (!sourceMaker?.documentId || !targetMaker?.documentId) continue;
        if (sourceMaker.documentId === targetMaker.documentId) continue;

        makersByDocumentId.set(sourceMaker.documentId, sourceMaker);
        makersByDocumentId.set(targetMaker.documentId, targetMaker);

        addEdge(sourceMaker.documentId, targetMaker.documentId);
        validRelations.push(relation);
      }

      // Score every maker by their 3-degree ego network size, then take the top N.
      const scored = [...makersByDocumentId.keys()].map((documentId) => ({
        documentId,
        egoSize: egoNetworkSize(documentId, adjacency, egoDepth),
      }));

      scored.sort((a, b) => b.egoSize - a.egoSize);
      const topEntries = scored.slice(0, limit);
      const topMakerIds = new Set(topEntries.map((e) => e.documentId));

      const nodes = topEntries.map(({ documentId, egoSize }) => {
        const maker = makersByDocumentId.get(documentId);
        return {
          id: documentId,
          documentId,
          maker_id: maker?.Maker_ID ?? null,
          surname: maker?.Surname ?? null,
          first_name: maker?.First_name ?? null,
          label: maker?.Label || [maker?.First_name, maker?.Surname].filter(Boolean).join(' ').trim() || String(documentId),
          ego_network_size: egoSize,
        };
      });

      const edges = validRelations
        .filter((relation) => {
          const sourceId = relation.maker_extended?.documentId;
          const targetId = relation.target_maker_extended?.documentId;
          return !!sourceId && !!targetId && topMakerIds.has(sourceId) && topMakerIds.has(targetId);
        })
        .map((relation) => ({
          id: relation.documentId ?? relation.id ?? String(relation.relation_id),
          relation_id: relation.relation_id,
          source: relation.maker_extended.documentId,
          target: relation.target_maker_extended.documentId,
          relation_code: relation.relation_code ?? null,
          relation_type_id: relation.relation_type_id ?? null,
          relation_type: relation.relation_type
            ? {
                id: relation.relation_type.documentId ?? relation.relation_type.id ?? null,
                documentId: relation.relation_type.documentId ?? null,
                name: relation.relation_type.name ?? relation.relation_type.type ?? null,
              }
            : null,
          relation_description: relation.relation_description ?? null,
          assigned_name: relation.assigned_name ?? null,
        }));

      ctx.body = {
        nodes,
        edges,
        meta: {
          limit,
          egoDepth,
          totalNodes: nodes.length,
          totalEdges: edges.length,
        },
      };
    } catch (err) {
      ctx.body = {
        error: 'An error occurred while fetching the summary data',
        details: err instanceof Error ? err.message : 'Unknown error',
      };
      ctx.status = 500; // Set the HTTP status code to 500 to indicate a server error
    }
  }
};
