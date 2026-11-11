// The only module that names lazily loaded chunks. Its content (chunk file
// names) changes on almost every deploy, so it gets its own startup chunk.
// It must contain *only* dynamic imports: a static import back into app code
// would create a cycle between startup chunks.
import type { PageModule } from './types.ts'

export const pages = import.meta.glob<PageModule>('../routes/**/page.tsx')
