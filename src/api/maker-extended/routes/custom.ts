export default {
  routes: [
    {
      method: 'GET',
      path: '/maker-extendeds/facet-counts',
      handler: 'api::maker-extended.maker-extended.getFacetCounts',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
