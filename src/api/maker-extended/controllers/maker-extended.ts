/**
 * maker controller
 */

import { factories } from '@strapi/strapi';

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

      ctx.body = {
        guilds: guildCounts,
        towns: townCounts,
      };
    } catch (error) {
      ctx.throw(500, 'Error fetching facet counts');
    }
  },
}));
