/**
 * maker controller
 */

import { factories } from '@strapi/strapi';

const ALT_LABEL_FIELDS = [
  'alternative_label_1',
  'alternative_label_2',
  'alternative_label_3',
  'alternative_label_4',
  'alternative_label_5',
  'alternative_label_6',
] as const;

const BROADER_LABEL_FIELDS = ['broader_1', 'broader_2', 'broader_3', 'broader_4'] as const;
const BROADER_ID_FIELDS = ['broader_1_id', 'broader_2_id', 'broader_3_id', 'broader_4_id'] as const;
const RELATED_LABEL_FIELDS = [
  'related_1',
  'related_2',
  'related_3',
  'related_4',
  'related_5',
  'related_6',
  'related_7',
  'related_8',
] as const;
const RELATED_ID_FIELDS = [
  'related_1_id',
  'related_2_id',
  'related_3_id',
  'related_4_id',
  'related_5_id',
  'related_6_id',
  'related_7_id',
  'related_8_id',
] as const;

function pushIfNonEmpty(target: Set<string>, value: unknown) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed) target.add(trimmed);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function collectAltLabels(term: any): string[] {
  const labels = new Set<string>();
  for (const field of ALT_LABEL_FIELDS) {
    pushIfNonEmpty(labels, term?.[field]);
  }
  return [...labels];
}

function collectBroaderLabels(term: any): string[] {
  const labels = new Set<string>();
  for (const field of BROADER_LABEL_FIELDS) {
    pushIfNonEmpty(labels, term?.[field]);
  }
  return [...labels];
}

function collectBroaderIds(term: any): string[] {
  const ids = new Set<string>();
  for (const field of BROADER_ID_FIELDS) {
    pushIfNonEmpty(ids, term?.[field]);
  }
  return [...ids];
}

function collectNarrowerTerms(
  rootTerm: any,
  childrenByBroaderId: Map<string, any[]>,
  childrenByBroaderLabel: Map<string, any[]>
): Array<{ id: number | null; termId: string | null; label: string }> {
  const resultByKey = new Map<string, { id: number | null; termId: string | null; label: string }>();
  const queue: any[] = [rootTerm];
  const visitedTermIds = new Set<number>();
  const visitedTermKeys = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current.id === 'number') {
      if (visitedTermIds.has(current.id)) continue;
      visitedTermIds.add(current.id);
    }

    if (typeof current.term_id === 'string' && current.term_id.trim() !== '') {
      visitedTermKeys.add(current.term_id.trim());
    }

    const narrowerCandidates = new Set<any>();

    if (typeof current.term_id === 'string' && current.term_id.trim() !== '') {
      const children = childrenByBroaderId.get(current.term_id.trim()) ?? [];
      for (const child of children) narrowerCandidates.add(child);
    }

    const currentLabel = String(current.preferred_label ?? '').trim();
    if (currentLabel) {
      const children = childrenByBroaderLabel.get(currentLabel.toLowerCase()) ?? [];
      for (const child of children) narrowerCandidates.add(child);
    }

    for (const child of narrowerCandidates) {
      const childLabel = String(child?.preferred_label ?? '').trim();
      if (childLabel) {
        const childTermId = typeof child?.term_id === 'string' && child.term_id.trim() !== '' ? child.term_id.trim() : null;
        const childId = typeof child?.id === 'number' ? child.id : null;
        const key = childId != null ? `id:${childId}` : childTermId ? `term:${childTermId}` : `label:${childLabel.toLowerCase()}`;
        if (!resultByKey.has(key)) {
          resultByKey.set(key, {
            id: childId,
            termId: childTermId,
            label: childLabel,
          });
        }
      }

      if (typeof child?.term_id === 'string' && child.term_id.trim() !== '' && visitedTermKeys.has(child.term_id.trim())) {
        continue;
      }

      if (typeof child?.id === 'number' && visitedTermIds.has(child.id)) {
        continue;
      }

      queue.push(child);
    }
  }

  return [...resultByKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isInstrumentClause(clause: any): boolean {
  if (!isObject(clause)) return false;
  if (clause.term_associations) return true;

  if (Array.isArray(clause.$or)) {
    return clause.$or.some((nested: any) => isInstrumentClause(nested));
  }

  if (Array.isArray(clause.$and)) {
    return clause.$and.some((nested: any) => isInstrumentClause(nested));
  }

  return false;
}

export default factories.createCoreController('api::maker-extended.maker-extended', ({ strapi }) => ({
  async getFacetCounts(ctx) {
    try {
      // Parse filters from query string
      const filters = ctx.query.filters ? JSON.parse(String(ctx.query.filters)) : {};

      // Extract the actual filter clauses from the $and array if present
      let filterClauses: any[] = [];
      if (filters.$and && Array.isArray(filters.$and)) {
        filterClauses = filters.$and;
      } else if (Object.keys(filters).length > 0) {
        filterClauses = [filters];
      }

      // Fetch guilds with counts
      const guildFilterClauses = filterClauses.filter((f) => !f.memberships);
      const guildFilters = guildFilterClauses.length > 0 ? { $and: guildFilterClauses } : {};

      const makersForGuilds = await strapi.entityService.findMany('api::maker-extended.maker-extended', {
        filters: guildFilters,
        populate: ['memberships.guild'],
        pagination: { limit: -1 },
      });

      const guildCounts: Record<string, number> = {};
      makersForGuilds.forEach((maker: any) => {
        if (maker.memberships && Array.isArray(maker.memberships)) {
          maker.memberships.forEach((m: any) => {
            const guildId = m.guild?.documentId;
            if (guildId) {
              guildCounts[guildId] = (guildCounts[guildId] || 0) + 1;
            }
          });
        }
      });

      // Fetch towns with counts
      const townFilterClauses = filterClauses.filter((f) => !f.addresses);
      const townFilters = townFilterClauses.length > 0 ? { $and: townFilterClauses } : {};

      const makersForTowns = await strapi.entityService.findMany('api::maker-extended.maker-extended', {
        filters: townFilters,
        populate: ['addresses.town_location'],
        pagination: { limit: -1 },
      });

      const townCounts: Record<string, number> = {};
      makersForTowns.forEach((maker: any) => {
        if (maker.addresses && Array.isArray(maker.addresses)) {
          maker.addresses.forEach((a: any) => {
            const townId = a.town_location?.id;
            if (townId) {
              townCounts[townId] = (townCounts[townId] || 0) + 1;
            }
          });
        }
      });

      // Fetch instrument terms with counts (combined known + advertised)
      const instrumentFilterClauses = filterClauses.filter((f) => !isInstrumentClause(f));
      const instrumentFilters = instrumentFilterClauses.length > 0 ? { $and: instrumentFilterClauses } : {};

      const makersForInstruments = await strapi.entityService.findMany('api::maker-extended.maker-extended', {
        filters: instrumentFilters,
        populate: ['term_associations.term'],
        pagination: { limit: -1 },
      });

      const instrumentCounts: Record<string, number> = {};
      const instrumentKnownCounts: Record<string, number> = {};
      const instrumentAdvertisedCounts: Record<string, number> = {};
      const instrumentLabels: Record<string, string> = {};
      makersForInstruments.forEach((maker: any) => {
        if (!maker.term_associations || !Array.isArray(maker.term_associations)) return;

        const makerTermIds = new Set<number>();
        const makerKnownTermIds = new Set<number>();
        const makerAdvertisedTermIds = new Set<number>();
        maker.term_associations.forEach((association: any) => {
          const termId = association.term?.id;
          if (typeof termId === 'number') {
            makerTermIds.add(termId);
            if (association.association_type === 'KNOWN') {
              makerKnownTermIds.add(termId);
            }
            if (association.association_type === 'ADVERTISED') {
              makerAdvertisedTermIds.add(termId);
            }
            if (!instrumentLabels[termId]) {
              const label = association.term?.preferred_label ?? association.term?.name;
              if (label) instrumentLabels[termId] = String(label);
            }
          }
        });

        makerTermIds.forEach((termId) => {
          instrumentCounts[termId] = (instrumentCounts[termId] || 0) + 1;
        });

        makerKnownTermIds.forEach((termId) => {
          instrumentKnownCounts[termId] = (instrumentKnownCounts[termId] || 0) + 1;
        });

        makerAdvertisedTermIds.forEach((termId) => {
          instrumentAdvertisedCounts[termId] = (instrumentAdvertisedCounts[termId] || 0) + 1;
        });
      });

      // Build richer search text so users can discover instruments by broader/narrower terms and alternatives.
      const allInstrumentTerms: any[] = await strapi.entityService.findMany('api::term.term', {
        filters: {
          vocabulary: {
            slug: { $eq: 'instruments' },
          },
        },
        fields: [
          'id',
          'term_id',
          'preferred_label',
          'alternative_label_1',
          'alternative_label_2',
          'alternative_label_3',
          'alternative_label_4',
          'alternative_label_5',
          'alternative_label_6',
          'broader_1',
          'broader_2',
          'broader_3',
          'broader_4',
          'broader_1_id',
          'broader_2_id',
          'broader_3_id',
          'broader_4_id',
          'related_1',
          'related_2',
          'related_3',
          'related_4',
          'related_5',
          'related_6',
          'related_7',
          'related_8',
          'related_1_id',
          'related_2_id',
          'related_3_id',
          'related_4_id',
          'related_5_id',
          'related_6_id',
          'related_7_id',
          'related_8_id',
        ],
        pagination: { limit: -1 },
      });

      const instrumentOptions = allInstrumentTerms
        .map((term) => {
          const id = Number(term?.id);
          const idKey = String(id);
          return {
            id,
            label:
              normalizeString(term?.preferred_label) ??
              instrumentLabels[idKey] ??
              `Instrument #${idKey}`,
            count: instrumentCounts[idKey] ?? 0,
            knownCount: instrumentKnownCounts[idKey] ?? 0,
            advertisedCount: instrumentAdvertisedCounts[idKey] ?? 0,
            termCode: null as number | null,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

      const termById = new Map<number, any>();
      const termByTermId = new Map<string, any>();
      const termsByLabel = new Map<string, any[]>();
      const childrenByBroaderId = new Map<string, any[]>();
      const childrenByBroaderLabel = new Map<string, any[]>();

      for (const term of allInstrumentTerms) {
        if (typeof term?.id === 'number') {
          termById.set(term.id, term);
        }

        if (typeof term?.term_id === 'string' && term.term_id.trim() !== '') {
          termByTermId.set(term.term_id.trim(), term);
        }

        const preferredLabel = String(term?.preferred_label ?? '').trim();
        if (preferredLabel) {
          const key = preferredLabel.toLowerCase();
          const bucket = termsByLabel.get(key) ?? [];
          bucket.push(term);
          termsByLabel.set(key, bucket);
        }

        const broaderIds = collectBroaderIds(term);
        broaderIds.forEach((broaderId) => {
          if (!childrenByBroaderId.has(broaderId)) {
            childrenByBroaderId.set(broaderId, []);
          }
          childrenByBroaderId.get(broaderId)?.push(term);
        });

        const broaderLabels = collectBroaderLabels(term);
        broaderLabels.forEach((broaderLabel) => {
          const key = broaderLabel.toLowerCase();
          if (!childrenByBroaderLabel.has(key)) {
            childrenByBroaderLabel.set(key, []);
          }
          childrenByBroaderLabel.get(key)?.push(term);
        });
      }

      const enrichedInstrumentOptions = instrumentOptions.map((option) => {
        const term = termById.get(option.id);
        if (!term) {
          return {
            ...option,
            searchText: option.label,
            alternativeLabels: [],
            relatedTerms: [],
            broaderTerms: [],
            narrowerTerms: [],
          };
        }

        const parsedTermCode = Number.parseInt(String(term.term_id ?? ''), 10);
        const termCode = Number.isNaN(parsedTermCode) ? null : parsedTermCode;

        const tokens = new Set<string>();
        pushIfNonEmpty(tokens, option.label);
        pushIfNonEmpty(tokens, term.preferred_label);

        const alternativeLabels = collectAltLabels(term);
        alternativeLabels.forEach((value) => pushIfNonEmpty(tokens, value));

        const broaderTerms: Array<{ id: number | null; termId: string | null; label: string }> = [];
        const broaderSeen = new Set<string>();
        for (let i = 0; i < BROADER_LABEL_FIELDS.length; i += 1) {
          const broaderLabel = String(term?.[BROADER_LABEL_FIELDS[i]] ?? '').trim();
          const broaderExternalId = String(term?.[BROADER_ID_FIELDS[i]] ?? '').trim();

          if (!broaderLabel && !broaderExternalId) continue;

          const resolved =
            (broaderExternalId ? termByTermId.get(broaderExternalId) : null) ??
            (broaderLabel ? (termsByLabel.get(broaderLabel.toLowerCase()) ?? [])[0] : null);

          const resolvedLabel = String(resolved?.preferred_label ?? broaderLabel).trim();
          if (!resolvedLabel) continue;

          const resolvedTermId =
            typeof resolved?.term_id === 'string' && resolved.term_id.trim() !== ''
              ? resolved.term_id.trim()
              : broaderExternalId || null;
          const resolvedId = typeof resolved?.id === 'number' ? resolved.id : null;

          const key = resolvedId != null ? `id:${resolvedId}` : resolvedTermId ? `term:${resolvedTermId}` : `label:${resolvedLabel.toLowerCase()}`;
          if (broaderSeen.has(key)) continue;
          broaderSeen.add(key);

          broaderTerms.push({
            id: resolvedId,
            termId: resolvedTermId,
            label: resolvedLabel,
          });

          pushIfNonEmpty(tokens, resolvedLabel);
        }

        const relatedTerms: Array<{ id: number | null; termId: string | null; label: string }> = [];
        const relatedSeen = new Set<string>();
        for (let i = 0; i < RELATED_LABEL_FIELDS.length; i += 1) {
          const relatedLabel = String(term?.[RELATED_LABEL_FIELDS[i]] ?? '').trim();
          const relatedExternalId = String(term?.[RELATED_ID_FIELDS[i]] ?? '').trim();

          if (!relatedLabel && !relatedExternalId) continue;

          const resolved =
            (relatedExternalId ? termByTermId.get(relatedExternalId) : null) ??
            (relatedLabel ? (termsByLabel.get(relatedLabel.toLowerCase()) ?? [])[0] : null);

          const resolvedLabel = String(resolved?.preferred_label ?? relatedLabel).trim();
          if (!resolvedLabel) continue;

          const resolvedTermId =
            typeof resolved?.term_id === 'string' && resolved.term_id.trim() !== ''
              ? resolved.term_id.trim()
              : relatedExternalId || null;
          const resolvedId = typeof resolved?.id === 'number' ? resolved.id : null;

          const key = resolvedId != null ? `id:${resolvedId}` : resolvedTermId ? `term:${resolvedTermId}` : `label:${resolvedLabel.toLowerCase()}`;
          if (relatedSeen.has(key)) continue;
          relatedSeen.add(key);

          relatedTerms.push({
            id: resolvedId,
            termId: resolvedTermId,
            label: resolvedLabel,
          });

          pushIfNonEmpty(tokens, resolvedLabel);
        }

        const narrowerTerms = collectNarrowerTerms(term, childrenByBroaderId, childrenByBroaderLabel);
        narrowerTerms.forEach((entry) => pushIfNonEmpty(tokens, entry.label));

        broaderTerms.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        relatedTerms.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

        return {
          ...option,
          termCode,
          searchText: [...tokens].join(' | '),
          alternativeLabels,
          relatedTerms,
          broaderTerms,
          narrowerTerms,
        };
      });

      ctx.body = {
        guilds: guildCounts,
        towns: townCounts,
        instruments: instrumentCounts,
        instrumentOptions: enrichedInstrumentOptions,
      };
    } catch (error) {
      ctx.throw(500, 'Error fetching facet counts');
    }
  },
}));
