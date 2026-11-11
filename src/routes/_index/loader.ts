import type { RouteLoader } from '../../router/types.ts'

export default {
  head: () => ({ status: 200, title: 'X-ish', description: 'Reconstruction demo', canonical: '/', ogType: 'website' }),
} satisfies RouteLoader
