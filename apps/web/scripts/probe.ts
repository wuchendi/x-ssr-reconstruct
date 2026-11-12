// Usage: node scripts/probe.ts <path> [person|search|preview] [--full]
const [path = '/ada', who = 'person', full] = process.argv.slice(2)
const headers: Record<string, string> = {}
if (who !== 'person') headers['x-edge-verified-bot'] = who
const t0 = performance.now()
const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3300}${path}`, { headers })
const ms = () => `${(performance.now() - t0).toFixed(0).padStart(5)}ms`
console.log(`${ms()} status=${res.status} server-timing=${res.headers.get('server-timing')}`)
const dec = new TextDecoder()
let body = ''
for await (const chunk of res.body!) {
  const s = dec.decode(chunk, { stream: true })
  body += s
  const tags = [...new Set(s.match(/<(title|article|script type="application\/json" data-rr="[^"]+"|template|div hidden id="S:\d+"|\/html)/g) ?? [])]
  console.log(`${ms()} +${String(chunk.length).padStart(6)}B  ${tags.join(' ').slice(0, 160)}`)
}
console.log(`${ms()} done total=${body.length}B scripts=${(body.match(/<script/g) ?? []).length} posts=${(body.match(/<article/g) ?? []).length} jsonld=${body.includes('ld+json')} rr=${(body.match(/data-rr=/g) ?? []).length}`)
if (full) console.log(body)
