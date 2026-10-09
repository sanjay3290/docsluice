export default {
  title: 'docsluice',
  description: 'Bounded, runtime-neutral document extraction for JavaScript.',
  srcDir: 'site',
  ignoreDeadLinks: ['/api/index'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/quickstart' },
      { text: 'Formats', link: '/formats/' },
      { text: 'Security', link: '/security' },
      { text: 'API', link: '/api/index.html' },
    ],
    sidebar: [
      { text: 'Get started', items: [{ text: 'Quick start', link: '/quickstart' }] },
      {
        text: 'Guides',
        items: [
          { text: 'Security model', link: '/security' },
          { text: 'Default limits', link: '/reference/limits' },
          { text: 'Formats', link: '/formats/' },
          { text: 'Recipes', link: '/recipes/' },
        ],
      },
    ],
  },
};
