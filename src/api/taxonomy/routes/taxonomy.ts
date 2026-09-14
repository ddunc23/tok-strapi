export default {
  routes: [
    {
      method: 'GET',
      path: '/taxonomy/makers',
      handler: 'taxonomy.makers',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/taxonomy/facets',
      handler: 'taxonomy.facets',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};