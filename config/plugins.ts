export default () => ({
    'rest-cache': {
    config: {
      provider: {
        name: 'memory',
        options: {
          maxSize: 32767,
        },
      },
      strategy: {
        contentTypes: [
          'api::term.term',
          'api::maker-term-association.maker-term-association',
          'api::town-location.town-location',
          'api::vocabulary.vocabulary',
          'api::guild.guild',
          {
            contentType: 'api::maker-extended.maker-extended',
            routes: [
                '/api/maker-extendeds/facet-counts',
            ]
          }
        ],
      },
    },
  },
});
