import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DefaultTheme } from 'vitepress'

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Locale = 'en' | 'zh-CN'

type SpecSection = {
  directory: string
  en: string
  zh: string
  collapsed?: boolean
}

const specSections: SpecSection[] = [
  { directory: '01-product', en: 'Product', zh: '产品' },
  { directory: '02-architecture', en: 'Architecture', zh: '架构' },
  { directory: '03-runtime', en: 'Runtime', zh: '运行时', collapsed: true },
  { directory: '04-ux', en: 'Experience', zh: '用户体验', collapsed: true },
  { directory: '05-security', en: 'Security', zh: '安全', collapsed: true },
  { directory: '06-delivery', en: 'Delivery', zh: '交付', collapsed: true },
  { directory: '07-plugins', en: 'Plugins', zh: '插件', collapsed: true },
  { directory: '08-meta', en: 'Decisions & metadata', zh: '决策与元数据', collapsed: true },
]

const preferredRootFiles = ['README.md', '00-baseline.md', 'NAV.md']

function titleFromMarkdown(filePath: string): string {
  const source = fs.readFileSync(filePath, 'utf8')
  const frontmatterTitle = source.match(/^---[\s\S]*?^title:\s*(.+?)\s*$[\s\S]*?^---/m)?.[1]
  if (frontmatterTitle) return frontmatterTitle.replace(/^['"]|['"]$/g, '')
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, '') ?? path.basename(filePath, '.md')
}

function specItems(directory: string, locale: Locale): DefaultTheme.SidebarItem[] {
  const sourceDirectory = path.join(docsRoot, locale === 'en' ? 'spec' : 'zh-CN/spec', directory)
  const routePrefix = locale === 'en' ? '/spec' : '/zh-CN/spec'
  if (!fs.existsSync(sourceDirectory)) return []
  return fs.readdirSync(sourceDirectory)
    .filter((file) => file.endsWith('.md'))
    .sort((left, right) => {
      if (left === 'README.md') return -1
      if (right === 'README.md') return 1
      return left.localeCompare(right, 'en')
    })
    .map((file) => ({
      text: titleFromMarkdown(path.join(sourceDirectory, file)),
      link: `${routePrefix}/${directory}/${file.slice(0, -3)}`,
    }))
}

function adrItems(): DefaultTheme.SidebarItem[] {
  const directory = path.join(docsRoot, 'adr')
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((file) => ({
      text: titleFromMarkdown(path.join(directory, file)),
      link: `/adr/${file.slice(0, -3)}`,
    }))
}

function projectItems(): DefaultTheme.SidebarItem[] {
  const directory = path.join(docsRoot, 'project')
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort((left, right) => {
      if (left === 'README.md') return -1
      if (right === 'README.md') return 1
      return left.localeCompare(right, 'en')
    })
    .map((file) => ({
      text: titleFromMarkdown(path.join(directory, file)),
      link: `/project/${file.slice(0, -3)}`,
    }))
}

function specSidebar(locale: Locale): DefaultTheme.SidebarItem[] {
  const localizedRoot = path.join(docsRoot, locale === 'en' ? 'spec' : 'zh-CN/spec')
  const routePrefix = locale === 'en' ? '/spec' : '/zh-CN/spec'
  const rootFiles = fs.readdirSync(localizedRoot)
    .filter((file) => file.endsWith('.md'))
  const startItems = preferredRootFiles
    .filter((file) => fs.existsSync(path.join(localizedRoot, file)))
    .map((file) => ({
      text: titleFromMarkdown(path.join(localizedRoot, file)),
      link: `${routePrefix}/${file.slice(0, -3)}`,
    }))
  const referenceItems = rootFiles
    .filter((file) => !preferredRootFiles.includes(file))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((file) => ({
      text: titleFromMarkdown(path.join(localizedRoot, file)),
      link: `${routePrefix}/${file.slice(0, -3)}`,
    }))

  return [
    { text: locale === 'en' ? 'Start here' : '从这里开始', items: startItems },
    ...specSections.map((section) => ({
      text: locale === 'en' ? section.en : section.zh,
      collapsed: section.collapsed,
      items: specItems(section.directory, locale),
    })),
    ...(referenceItems.length ? [{
      text: locale === 'en' ? 'Compatibility references' : '兼容性参考',
      collapsed: true,
      items: referenceItems,
    }] : []),
  ]
}

const enSidebar: DefaultTheme.Sidebar = {
  '/guide/': [{ text: 'Guide', items: [{ text: 'Start here', link: '/guide/' }, { text: 'Screens', link: '/guide/screenshots' }] }],
  '/plugin-development': [{ text: 'Plugin authoring', items: [{ text: 'Zero to one', link: '/plugin-development' }, ...specItems('07-plugins', 'en')] }],
  '/project/': [{ text: 'Project records', items: projectItems() }],
  '/spec/': specSidebar('en'),
  '/adr/': [
    {
      text: 'Architecture decisions',
      items: [
        { text: 'ADR index', link: '/adr/README' },
        { text: 'Documentation site', link: '/adr/0079-vitepress-documentation-site' },
        { text: 'Latest decisions', link: '/spec/08-meta/decisions-log' },
      ],
    },
    { text: 'All decisions', collapsed: true, items: adrItems() },
  ],
}

const zhSidebar: DefaultTheme.Sidebar = {
  '/zh-CN/guide/': [{ text: '指南', items: [{ text: '快速开始', link: '/zh-CN/guide/' }, { text: '界面截图', link: '/zh-CN/guide/screenshots' }] }],
  '/zh-CN/plugin-development': [{ text: '插件开发', items: [{ text: '从零到一', link: '/zh-CN/plugin-development' }, ...specItems('07-plugins', 'zh-CN')] }],
  '/zh-CN/spec/': specSidebar('zh-CN'),
  '/zh-CN/adr/': [
    {
      text: '架构决策记录',
      items: [
        { text: 'ADR 索引', link: '/zh-CN/adr/' },
        { text: '文档站决策', link: '/adr/0079-vitepress-documentation-site' },
        { text: '最新决策', link: '/zh-CN/spec/08-meta/decisions-log' },
      ],
    },
    { text: '全部英文决策', collapsed: true, items: adrItems() },
  ],
}

const enNav: DefaultTheme.NavItem[] = [
  { text: 'Guide', link: '/guide/' },
  { text: 'Specs', link: '/spec/README' },
  { text: 'ADRs', link: '/adr/README' },
  { text: 'Plugin guide', link: '/plugin-development' },
  { text: 'GitHub', link: 'https://github.com/vastsa/PI-Desktop' },
]

const zhNav: DefaultTheme.NavItem[] = [
  { text: '快速开始', link: '/zh-CN/guide/' },
  { text: '规格', link: '/zh-CN/spec/README' },
  { text: 'ADR', link: '/zh-CN/adr/' },
  { text: '插件开发', link: '/zh-CN/plugin-development' },
  { text: 'GitHub', link: 'https://github.com/vastsa/PI-Desktop' },
]

export default defineConfig({
  title: 'PI-Desktop',
  description: 'Local-first AI coding agent documentation',
  appearance: true,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#f8fafc' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap' }],
  ],
  locales: {
    root: { label: 'English', lang: 'en' },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'PI-Desktop 文档',
      description: '本地优先的 AI 编程代理文档',
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        search: { provider: 'local', options: { translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' }, modal: { noResultsText: '没有找到相关结果', resetButtonTitle: '清除查询', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } } } },
        outline: { level: 'deep', label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新于' },
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        langMenuLabel: '切换语言',
        editLink: { pattern: 'https://github.com/vastsa/PI-Desktop/edit/main/docs/:path', text: '在 GitHub 上编辑此页' },
        footer: { message: '为本地优先开发而构建。', copyright: 'Copyright © 2026 PI-Desktop 贡献者' },
      },
    },
  },
  markdown: {
    html: false,
    lineNumbers: true,
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  themeConfig: {
    logo: '/brand-mark.svg',
    siteTitle: 'PI-Desktop',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/vastsa/PI-Desktop' }],
    editLink: { pattern: 'https://github.com/vastsa/PI-Desktop/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    outline: { level: 'deep', label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: { message: 'Built for local-first development.', copyright: 'Copyright © 2026 PI-Desktop contributors' },
    nav: enNav,
    sidebar: enSidebar,
  },
})
