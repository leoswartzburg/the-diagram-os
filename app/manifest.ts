import type { MetadataRoute } from 'next'

// PWA manifest — required for iOS "Add to Home Screen", which is itself required for Web Push
// on iOS (16.4+). display:'standalone' makes the installed app count as a web app so push works.
// Next serves this at /manifest.webmanifest and links it in <head> automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'The Diagram',
    short_name: 'Diagram',
    description: 'Personal AI Operating System — powered by Spectre',
    start_url: '/',
    display: 'standalone',
    background_color: '#03030A',
    theme_color: '#03030A',
    orientation: 'portrait',
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { src: '/icon-512.png', type: 'image/png', sizes: '512x512' },
      { src: '/icon-maskable-512.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
    ],
  }
}
