<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ locale: string }>()
const isZh = computed(() => props.locale === 'zh-CN')
</script>

<template>
  <div class="home-console" :aria-label="isZh ? 'PI-Desktop 系统边界预览' : 'PI-Desktop system boundary preview'">
    <div class="home-console__topbar">
      <span class="home-console__traffic"><i></i><i></i><i></i></span>
      <span>{{ isZh ? 'system / overview' : 'system / overview' }}</span>
      <span class="home-console__status">{{ isZh ? 'LOCAL' : 'LOCAL' }}</span>
    </div>
    <div class="home-console__body">
      <div class="home-console__rail">
        <span class="home-console__rail-mark">P</span>
        <span></span><span></span><span></span>
      </div>
      <div class="home-console__canvas">
        <div class="home-console__caption">{{ isZh ? 'RUNTIME TOPOLOGY' : 'RUNTIME TOPOLOGY' }}</div>
        <div class="home-console__graph">
          <div class="home-console__node home-console__node--accent"><b>01</b><strong>Renderer</strong><small>presentation</small></div>
          <span class="home-console__line home-console__line--one"></span>
          <div class="home-console__node"><b>02</b><strong>Electron</strong><small>orchestration</small></div>
          <span class="home-console__line home-console__line--two"></span>
          <div class="home-console__node"><b>03</b><strong>Rust host</strong><small>authority</small></div>
          <span class="home-console__line home-console__line--three"></span>
          <div class="home-console__node home-console__node--state"><b>04</b><strong>SQLite</strong><small>durable state</small></div>
        </div>
        <div class="home-console__footer"><span>protocol v9</span><span>schema v11</span><span>inspectable by default</span></div>
      </div>
    </div>
  </div>
</template>
