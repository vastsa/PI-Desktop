<script setup lang="ts">
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import HomeHeroVisual from './components/HomeHeroVisual.vue'
import HomeModules from './components/HomeModules.vue'

const { Layout } = DefaultTheme
const { frontmatter, localeIndex } = useData()
</script>

<template>
  <Layout>
    <template #home-hero-image>
      <HomeHeroVisual :locale="localeIndex" />
    </template>
    <template #home-features-after>
      <HomeModules :locale="localeIndex" v-if="frontmatter.layout === 'home'" />
    </template>
  </Layout>
</template>
