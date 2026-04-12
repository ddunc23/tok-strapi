export default {
  routes: [
    {
      method: 'GET',
      path: '/graph',
      handler: 'graph.topNodes',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
