<script setup lang="ts">
const shotSrc = '/readme/home.webp'
</script>

<template>
  <div class="hero-visual" aria-hidden="false">
    <div class="hero-visual__glow"></div>
    <img
      class="hero-visual__shot"
      :src="shotSrc"
      alt="PI-Desktop workspace"
      width="2560"
      height="1440"
      decoding="async"
      fetchpriority="high"
    />
  </div>
</template>
