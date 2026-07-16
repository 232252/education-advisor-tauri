import http from 'node:http'

const get = (u) => new Promise((r, j) => {
  http.get(u, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => {
      try { r(JSON.parse(d)) } catch (e) { j(new Error('parse error: ' + d.substring(0, 200))) }
    })
  }).on('error', j)
})

try {
  const targets = await get('http://127.0.0.1:9222/json')
  console.log('CDP OK, total targets:', targets.length)
  const pages = targets.filter((x) => x.type === 'page')
  console.log('Page targets:', pages.length)
  for (const p of pages) {
    console.log(`  url=${p.url} title=${p.title}`)
  }
  if (pages.length === 0) {
    console.log('NO page target found! All targets:')
    for (const t of targets) {
      console.log(`  type=${t.type} url=${t.url}`)
    }
  }
} catch (e) {
  console.log('CDP error:', e.message)
}
