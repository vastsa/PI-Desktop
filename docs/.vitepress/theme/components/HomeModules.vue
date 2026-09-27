<script setup lang="ts">
import { computed } from 'vue'

type Locale = 'root' | 'zh-CN' | string

const props = defineProps<{ locale: Locale }>()
const isZh = computed(() => props.locale === 'zh-CN')

const copy = computed(() => isZh.value ? {
  eyebrow: 'PI-DESKTOP / DOCUMENTATION SYSTEM',
  title: '从意图进入，从边界深入。',
  intro: '这不是一份按文件堆叠的目录，而是一张能帮助你定位、理解、修改和验证系统的地图。',
  journeyLabel: '按意图阅读',
  journeyTitle: '先回答你正在解决的问题。',
  journeys: [
    { index: '01', label: 'ORIENT', title: '建立产品模型', text: '先知道当前交付了什么、明确不做什么。', link: '/zh-CN/guide/' },
    { index: '02', label: 'TRACE', title: '追踪一次请求', text: '从 Renderer 走到 Electron、pi、Rust host 和 SQLite。', link: '/zh-CN/spec/02-architecture/01-architecture' },
    { index: '03', label: 'EXTEND', title: '开发一个插件', text: '从包格式、API、权限到生命周期逐步展开。', link: '/zh-CN/plugin-development' },
    { index: '04', label: 'SHIP', title: '验证一次变化', text: '把规格、实现、E2E 场景和交付记录连起来。', link: '/zh-CN/spec/06-delivery/README' },
  ],
  mapLabel: '系统地图',
  mapTitle: '四层边界，保持一条阅读主线。',
  layers: [
    { name: 'Shell', detail: 'Electron', text: '桌面窗口、preload IPC、生命周期和平台能力。' },
    { name: 'Agent', detail: 'pi sidecar', text: '代理循环、工具调用、上下文与 provider-facing model work。' },
    { name: 'Host', detail: 'Rust core', text: '权限、进程、文件系统、RPC 和可取消的运行时边界。' },
    { name: 'State', detail: 'SQLite', text: '会话、配置、检查点、插件状态和持久化所有权。' },
  ],
  shelfLabel: '参考书架',
  shelfTitle: '按主题深入，而不是在文件树里迷路。',
  shelves: [
    { title: '产品', text: '范围、操作模式和非目标。', link: '/zh-CN/spec/01-product/README' },
    { title: '架构', text: '进程、数据和工程结构。', link: '/zh-CN/spec/02-architecture/README' },
    { title: '运行时', text: '协议、工具、host 和模型。', link: '/zh-CN/spec/03-runtime/README' },
    { title: '体验', text: '信息架构、国际化和交互。', link: '/zh-CN/spec/04-ux/README' },
    { title: '安全', text: '权限、路径和隔离边界。', link: '/zh-CN/spec/05-security/README' },
    { title: '交付', text: '验收、E2E 和发布。', link: '/zh-CN/spec/06-delivery/README' },
    { title: '插件', text: '扩展包、API 和生命周期。', link: '/zh-CN/spec/07-plugins/README' },
    { title: '决策', text: 'ADR、决策日志和开放问题。', link: '/zh-CN/spec/08-meta/README' },
  ],
  snapshotLabel: '实现快照',
  snapshotTitle: '当前文档描述的版本线。',
  snapshot: [['应用版本线', '0.5.8'], ['Host wire protocol', 'v9'], ['Storage schema', 'v11'], ['文档源语言', 'EN / 中文']],
  footerTitle: '准备好进入代码库了吗？',
  footerText: '从快速开始建立上下文，或者直接打开规格索引。',
  footerPrimary: '开始阅读',
  footerSecondary: '查看规格索引',
  footerPrimaryLink: '/zh-CN/guide/',
  footerSecondaryLink: '/zh-CN/spec/README',
} : {
  eyebrow: 'PI-DESKTOP / DOCUMENTATION SYSTEM',
  title: 'Enter by intent. Go deeper by boundary.',
  intro: 'This is not a file dump. It is a map for locating, understanding, changing, and validating the system.',
  journeyLabel: 'Read by intent',
  journeyTitle: 'Start with the question you are solving.',
  journeys: [
    { index: '01', label: 'ORIENT', title: 'Build the product model', text: 'Know what is shipped and what is deliberately out of scope.', link: '/guide/' },
    { index: '02', label: 'TRACE', title: 'Trace one request', text: 'Follow the path through Renderer, Electron, pi, Rust host, and SQLite.', link: '/spec/02-architecture/01-architecture' },
    { index: '03', label: 'EXTEND', title: 'Build a plugin', text: 'Move from package format to API, permissions, and lifecycle.', link: '/plugin-development' },
    { index: '04', label: 'SHIP', title: 'Validate a change', text: 'Connect the spec, implementation, E2E scenario, and delivery record.', link: '/spec/06-delivery/README' },
  ],
  mapLabel: 'System map',
  mapTitle: 'Four boundaries. One readable thread.',
  layers: [
    { name: 'Shell', detail: 'Electron', text: 'Windows, preload IPC, lifecycle, and platform capabilities.' },
    { name: 'Agent', detail: 'pi sidecar', text: 'Agent loop, tools, context, and provider-facing model work.' },
    { name: 'Host', detail: 'Rust core', text: 'Permissions, processes, filesystem, RPC, and cancellation.' },
    { name: 'State', detail: 'SQLite', text: 'Sessions, configuration, checkpoints, plugins, and ownership.' },
  ],
  shelfLabel: 'Reference shelf',
  shelfTitle: 'Go deep by topic, not by getting lost in the file tree.',
  shelves: [
    { title: 'Product', text: 'Scope, modes, and non-goals.', link: '/spec/01-product/README' },
    { title: 'Architecture', text: 'Processes, data, and structure.', link: '/spec/02-architecture/README' },
    { title: 'Runtime', text: 'Protocols, tools, host, and models.', link: '/spec/03-runtime/README' },
    { title: 'Experience', text: 'IA, internationalization, and interaction.', link: '/spec/04-ux/README' },
    { title: 'Security', text: 'Permissions, paths, and isolation.', link: '/spec/05-security/README' },
    { title: 'Delivery', text: 'Acceptance, E2E, and release.', link: '/spec/06-delivery/README' },
    { title: 'Plugins', text: 'Packages, APIs, and lifecycle.', link: '/spec/07-plugins/README' },
    { title: 'Decisions', text: 'ADRs, decisions, and open questions.', link: '/spec/08-meta/README' },
  ],
  snapshotLabel: 'Implementation snapshot',
  snapshotTitle: 'The line this documentation describes.',
  snapshot: [['Application line', '0.5.8'], ['Host wire protocol', 'v9'], ['Storage schema', 'v11'], ['Source languages', 'EN / 中文']],
  footerTitle: 'Ready to enter the codebase?',
  footerText: 'Build context with the guide, or open the full specification index.',
  footerPrimary: 'Start reading',
  footerSecondary: 'Open spec index',
  footerPrimaryLink: '/guide/',
  footerSecondaryLink: '/spec/README',
})
</script>

<template>
  <div class="home-modules">
    <section class="home-block home-block--journeys" aria-labelledby="home-journeys-title">
      <div class="home-block__heading">
        <div>
          <p class="home-kicker">{{ copy.journeyLabel }}</p>
          <h2 id="home-journeys-title">{{ copy.journeyTitle }}</h2>
        </div>
        <p class="home-block__intro">{{ copy.intro }}</p>
      </div>
      <div class="home-journeys">
        <a v-for="journey in copy.journeys" :key="journey.index" class="home-journey" :href="journey.link">
          <span class="home-journey__index">{{ journey.index }}</span>
          <span class="home-journey__content">
            <span class="home-journey__label">{{ journey.label }}</span>
            <strong>{{ journey.title }}</strong>
            <span>{{ journey.text }}</span>
          </span>
          <span class="home-link-arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </section>

    <section class="home-block home-block--map" aria-labelledby="home-map-title">
      <div class="home-block__heading home-block__heading--compact">
        <div>
          <p class="home-kicker">{{ copy.mapLabel }}</p>
          <h2 id="home-map-title">{{ copy.mapTitle }}</h2>
        </div>
      </div>
      <div class="home-layers" role="list">
        <div v-for="(layer, index) in copy.layers" :key="layer.name" class="home-layer" role="listitem">
          <span class="home-layer__number">0{{ index + 1 }}</span>
          <span class="home-layer__name">{{ layer.name }}</span>
          <span class="home-layer__detail">{{ layer.detail }}</span>
          <span class="home-layer__text">{{ layer.text }}</span>
        </div>
      </div>
    </section>

    <section class="home-block home-block--shelf" aria-labelledby="home-shelf-title">
      <div class="home-block__heading">
        <div>
          <p class="home-kicker">{{ copy.shelfLabel }}</p>
          <h2 id="home-shelf-title">{{ copy.shelfTitle }}</h2>
        </div>
      </div>
      <div class="home-shelf">
        <a v-for="(shelf, index) in copy.shelves" :key="shelf.title" class="home-shelf__item" :href="shelf.link">
          <span class="home-shelf__number">{{ String(index + 1).padStart(2, '0') }}</span>
          <strong>{{ shelf.title }}</strong>
          <span>{{ shelf.text }}</span>
          <span class="home-link-arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="home-snapshot" aria-labelledby="home-snapshot-title">
      <div>
        <p class="home-kicker">{{ copy.snapshotLabel }}</p>
        <h2 id="home-snapshot-title">{{ copy.snapshotTitle }}</h2>
      </div>
      <div class="home-snapshot__grid" role="list">
        <div v-for="item in copy.snapshot" :key="item[0]" role="listitem">
          <span>{{ item[0] }}</span>
          <strong>{{ item[1] }}</strong>
        </div>
      </div>
    </section>

    <section class="home-cta" aria-labelledby="home-cta-title">
      <div>
        <p class="home-kicker">{{ copy.eyebrow }}</p>
        <h2 id="home-cta-title">{{ copy.footerTitle }}</h2>
        <p>{{ copy.footerText }}</p>
      </div>
      <div class="home-cta__actions">
        <a class="home-button home-button--primary" :href="copy.footerPrimaryLink">{{ copy.footerPrimary }}</a>
        <a class="home-button home-button--secondary" :href="copy.footerSecondaryLink">{{ copy.footerSecondary }}</a>
      </div>
    </section>
  </div>
</template>
