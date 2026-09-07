/**
 * taxonomy controller
 */

type TaxonomyQuery = {
  vocabulary?: string;
  vocabularyId?: string;
  termId?: string;
  termSlug?: string;
  associationType?: string;
  includeDescendants?: string;
  page?: string;
  pageSize?: string;
};

const ASSOCIATION_TYPES = new Set(['KNOWN', 'ADVERTISED']);

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return defaultValue;
}

async function resolveVocabularyId(query: TaxonomyQuery): Promise<number | null> {
  const explicitId = parsePositiveInt(query.vocabularyId);
  if (explicitId) return explicitId;
  if (!query.vocabulary) return null;

  const vocab = await strapi.db.query('api::vocabulary.vocabulary').findOne({
    where: { slug: query.vocabulary },
    select: ['id'],
  });

  return vocab?.id ?? null;
}

async function resolveSeedTerm(query: TaxonomyQuery, vocabularyId: number | null): Promise<any | null> {
  const termId = parsePositiveInt(query.termId);
  if (termId) {
    return strapi.db.query('api::term.term').findOne({
      where: {
        id: termId,
        ...(vocabularyId ? { vocabulary: { id: vocabularyId } } : {}),
      },
      select: ['id', 'preferred_label', 'slug'],
      populate: {
        parent: {
          select: ['id'],
        },
      },
    });
  }

  if (!query.termSlug) return null;
  return strapi.db.query('api::term.term').findOne({
    where: {
      slug: query.termSlug,
      ...(vocabularyId ? { vocabulary: { id: vocabularyId } } : {}),
    },
    select: ['id', 'preferred_label', 'slug'],
    populate: {
      parent: {
        select: ['id'],
      },
    },
  });
}

async function buildTermScope(
  query: TaxonomyQuery,
  vocabularyId: number | null,
): Promise<{ termIds: number[] | null; seedTermId: number | null }> {
  const seedTerm = await resolveSeedTerm(query, vocabularyId);
  if (!seedTerm) return { termIds: null, seedTermId: null };

  const includeDescendants = parseBoolean(query.includeDescendants, false);
  if (!includeDescendants) return { termIds: [seedTerm.id], seedTermId: seedTerm.id };

  const terms = await strapi.db.query('api::term.term').findMany({
    where: {
      ...(vocabularyId ? { vocabulary: { id: vocabularyId } } : {}),
    },
    select: ['id'],
    populate: {
      parent: {
        select: ['id'],
      },
    },
  });

  const childrenByParent = new Map<number, number[]>();
  for (const term of terms) {
    const parentId = term.parent?.id;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(term.id);
    childrenByParent.set(parentId, children);
  }

  const result = new Set<number>([seedTerm.id]);
  const queue = [seedTerm.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenByParent.get(current) ?? [];
    for (const childId of children) {
      if (result.has(childId)) continue;
      result.add(childId);
      queue.push(childId);
    }
  }

  return { termIds: [...result], seedTermId: seedTerm.id };
}

function normalizeAssociationType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ASSOCIATION_TYPES.has(normalized) ? normalized : null;
}

export default {
  makers: async (ctx) => {
    try {
      const query = ctx.query as TaxonomyQuery;
      const associationType = normalizeAssociationType(query.associationType);
      if (query.associationType && !associationType) {
        ctx.status = 400;
        ctx.body = { error: 'associationType must be one of KNOWN or ADVERTISED' };
        return;
      }

      const vocabularyId = await resolveVocabularyId(query);
      const { termIds, seedTermId } = await buildTermScope(query, vocabularyId);

      const page = parsePositiveInt(query.page) ?? 1;
      const pageSize = Math.min(parsePositiveInt(query.pageSize) ?? 50, 200);

      const where: any = {
        ...(associationType ? { association_type: associationType } : {}),
        ...(vocabularyId ? { term: { vocabulary: { id: vocabularyId } } } : {}),
        ...(termIds ? { term: { ...(vocabularyId ? { vocabulary: { id: vocabularyId } } : {}), id: { $in: termIds } } } : {}),
      };

      const associations = await strapi.db.query('api::maker-term-association.maker-term-association').findMany({
        where,
        populate: {
          maker_extended: {
            select: ['id', 'documentId', 'Maker_ID', 'Label', 'First_name', 'Surname'],
          },
          term: {
            select: ['id', 'documentId', 'preferred_label', 'slug'],
            populate: {
              vocabulary: {
                select: ['id', 'name', 'slug'],
              },
            },
          },
        },
        orderBy: [{ maker_extended: { Maker_ID: 'asc' } }, { term: { preferred_label: 'asc' } }],
      });

      const makersById = new Map<number, any>();
      for (const association of associations) {
        const maker = association.maker_extended;
        const term = association.term;
        if (!maker || !term) continue;

        if (!makersById.has(maker.id)) {
          const fallbackLabel = [maker.First_name, maker.Surname].filter(Boolean).join(' ').trim();
          makersById.set(maker.id, {
            id: maker.id,
            documentId: maker.documentId ?? null,
            maker_id: maker.Maker_ID ?? null,
            label: maker.Label ?? (fallbackLabel || null),
            terms: [],
          });
        }

        makersById.get(maker.id).terms.push({
          associationType: association.association_type,
          term: {
            id: term.id,
            documentId: term.documentId ?? null,
            preferred_label: term.preferred_label,
            slug: term.slug,
            vocabulary: term.vocabulary
              ? {
                  id: term.vocabulary.id,
                  name: term.vocabulary.name,
                  slug: term.vocabulary.slug,
                }
              : null,
          },
        });
      }

      const allMakers = [...makersById.values()];
      const start = (page - 1) * pageSize;
      const pagedMakers = allMakers.slice(start, start + pageSize);

      ctx.body = {
        data: pagedMakers,
        meta: {
          page,
          pageSize,
          total: allMakers.length,
          associationType: associationType ?? null,
          vocabularyId,
          seedTermId,
          includeDescendants: parseBoolean(query.includeDescendants, false),
        },
      };
    } catch (err) {
      ctx.status = 500;
      ctx.body = {
        error: 'An error occurred while fetching makers by taxonomy.',
        details: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },

  facets: async (ctx) => {
    try {
      const query = ctx.query as TaxonomyQuery;
      const associationType = normalizeAssociationType(query.associationType);
      if (query.associationType && !associationType) {
        ctx.status = 400;
        ctx.body = { error: 'associationType must be one of KNOWN or ADVERTISED' };
        return;
      }

      const vocabularyId = await resolveVocabularyId(query);

      const where: any = {
        ...(associationType ? { association_type: associationType } : {}),
        ...(vocabularyId ? { term: { vocabulary: { id: vocabularyId } } } : {}),
      };

      const associations = await strapi.db.query('api::maker-term-association.maker-term-association').findMany({
        where,
        populate: {
          maker_extended: {
            select: ['id'],
          },
          term: {
            select: ['id', 'preferred_label', 'slug'],
            populate: {
              vocabulary: {
                select: ['id', 'name', 'slug'],
              },
            },
          },
        },
      });

      const facetsByTermId = new Map<number, any>();
      for (const association of associations) {
        const makerId = association.maker_extended?.id;
        const term = association.term;
        if (!makerId || !term) continue;

        if (!facetsByTermId.has(term.id)) {
          facetsByTermId.set(term.id, {
            term: {
              id: term.id,
              preferred_label: term.preferred_label,
              slug: term.slug,
              vocabulary: term.vocabulary
                ? {
                    id: term.vocabulary.id,
                    name: term.vocabulary.name,
                    slug: term.vocabulary.slug,
                  }
                : null,
            },
            makerIds: new Set<number>(),
            knownMakerIds: new Set<number>(),
            advertisedMakerIds: new Set<number>(),
          });
        }

        const bucket = facetsByTermId.get(term.id);
        bucket.makerIds.add(makerId);
        if (association.association_type === 'KNOWN') bucket.knownMakerIds.add(makerId);
        if (association.association_type === 'ADVERTISED') bucket.advertisedMakerIds.add(makerId);
      }

      const data = [...facetsByTermId.values()]
        .map((entry) => ({
          term: entry.term,
          counts: {
            total: entry.makerIds.size,
            known: entry.knownMakerIds.size,
            advertised: entry.advertisedMakerIds.size,
          },
        }))
        .sort((a, b) => {
          if (b.counts.total !== a.counts.total) return b.counts.total - a.counts.total;
          return a.term.preferred_label.localeCompare(b.term.preferred_label);
        });

      ctx.body = {
        data,
        meta: {
          totalTerms: data.length,
          associationType: associationType ?? null,
          vocabularyId,
        },
      };
    } catch (err) {
      ctx.status = 500;
      ctx.body = {
        error: 'An error occurred while building taxonomy facets.',
        details: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },
};