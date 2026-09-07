export default {
  routes: [
    {
      method: 'GET',
      path: '/taxonomy/makers',
      handler: 'taxonomy.makers',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/taxonomy/facets',
      handler: 'taxonomy.facets',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};