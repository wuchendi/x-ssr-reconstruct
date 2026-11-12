// Runs the API on several processes sharing one port (node:cluster), so it
// is not the bottleneck when load-testing the web tier.
//   API_PROCESSES=4 PORT=3302 node apps/api/scripts/cluster.mjs
import cluster from 'node:cluster'

if (cluster.isPrimary) {
  const n = Number(process.env.API_PROCESSES ?? 4)
  for (let i = 0; i < n; i++) cluster.fork()
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(sig)
      process.exit(0)
    })
  }
} else {
  await import('../src/main.ts')
}
