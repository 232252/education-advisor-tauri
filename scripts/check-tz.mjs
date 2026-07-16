const n = new Date()
const local = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
console.log('UTC:', n.toISOString().slice(0, 10))
console.log('Local:', local)
console.log('TZ:', Intl.DateTimeFormat().resolvedOptions().timeZone)
console.log('Match:', n.toISOString().slice(0, 10) === local)
