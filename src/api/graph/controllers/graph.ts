/**
 * A set of functions called "actions" for `graph`
 */

export default {
  topNodes: async (ctx) => {
    try {
      const requestedLimit = Number.parseInt(String(ctx.query.limit ?? '100'), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;

      const relations = await strapi.db.query('api::relation.relation').findMany({
        where: {
          maker: {
            id: {
              $notNull: true,
            },
          },
          target_maker: {
            id: {
              $notNull: true,
            },
          },
        },
        populate: {
          maker: true,
          target_maker: true,
          relation_type: true,
        },
      });

      const degreeByMakerDocumentId = new Map<string, number>();
      const makersByDocumentId = new Map<string, any>();
      const validRelations = [];

      for (const relation of relations) {
        const sourceMaker = relation.maker;
        const targetMaker = relation.target_maker;

        if (!sourceMaker?.documentId || !targetMaker?.documentId) continue;
        if (sourceMaker.documentId === targetMaker.documentId) continue;

        makersByDocumentId.set(sourceMaker.documentId, sourceMaker);
        makersByDocumentId.set(targetMaker.documentId, targetMaker);

        degreeByMakerDocumentId.set(
          sourceMaker.documentId,
          (degreeByMakerDocumentId.get(sourceMaker.documentId) ?? 0) + 1
        );
        degreeByMakerDocumentId.set(
          targetMaker.documentId,
          (degreeByMakerDocumentId.get(targetMaker.documentId) ?? 0) + 1
        );

        validRelations.push(relation);
      }

      const topMakers = [...degreeByMakerDocumentId.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      const topMakerIds = new Set(topMakers.map(([documentId]) => documentId));

      const nodes = topMakers.map(([documentId, degree]) => {
        const maker = makersByDocumentId.get(documentId);
        return {
          id: documentId,
          documentId,
          maker_id: maker?.maker_id ?? null,
          surname: maker?.surname ?? null,
          first_name: maker?.first_name ?? null,
          label: [maker?.first_name, maker?.surname].filter(Boolean).join(' ').trim() || maker?.surname || String(documentId),
          degree,
        };
      });

      const edges = validRelations
        .filter((relation) => {
          const sourceId = relation.maker?.documentId;
          const targetId = relation.target_maker?.documentId;
          return !!sourceId && !!targetId && topMakerIds.has(sourceId) && topMakerIds.has(targetId);
        })
        .map((relation) => ({
          id: relation.documentId ?? relation.id ?? String(relation.relation_id),
          relation_id: relation.relation_id,
          source: relation.maker.documentId,
          target: relation.target_maker.documentId,
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
