import http from 'node:http'
import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:9222'

http.get(BASE + '/json', (res) => {
  let data = ''
  res.on('data', c => data += c)
  res.on('end', async () => {
    const targets = JSON.parse(data).filter(t => t.type === 'page')
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    let id = 1
    const pending = new Map()
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    })
    await new Promise(r => ws.on('open', r))
    const send = (method, params = {}) => new Promise(r => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalP = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      return r.result?.result?.value
    }

    // Navigate to students
    await evalP("location.hash='#/students'; await new Promise(r=>setTimeout(r,2000));")

    // Check DOM structure
    const info = await evalP(`(function(){
      const tables = document.querySelectorAll('table');
      const tbodyRows = document.querySelectorAll('table tbody tr');
      const allTrs = document.querySelectorAll('tr');
      const asides = document.querySelectorAll('aside');
      const lis = document.querySelectorAll('aside li');
      const divs = document.querySelectorAll('aside div');
      const studentNames = [];
      const clickableDivs = document.querySelectorAll('aside [class*="cursor"], aside [class*="hover"], aside [role="button"]');
      for (const el of clickableDivs) {
        const t = (el.textContent||'').trim().substring(0,30);
        if (t) studentNames.push(t);
      }
      // Also check main content area
      const mainDivs = document.querySelectorAll('main div, [class*="content"] div');
      const bodyLen = (document.body.textContent||'').length;
      const bodyStart = (document.body.textContent||'').substring(0,300);
      return JSON.stringify({
        tables: tables.length,
        tbodyRows: tbodyRows.length,
        allTrs: allTrs.length,
        asides: asides.length,
        asideLis: lis.length,
        asideDivs: divs.length,
        clickableDivs: clickableDivs.length,
        studentNamesSample: studentNames.slice(0,5),
        mainDivs: mainDivs.length,
        bodyLen,
        bodyStart
      }, null, 2);
    })()`)
    console.log('Students page DOM:')
    console.log(info)

    // Navigate to academics
    await evalP("location.hash='#/academics'; await new Promise(r=>setTimeout(r,2000));")
    const acadInfo = await evalP(`(function(){
      const asides = document.querySelectorAll('aside');
      const asideChildren = [];
      for (const a of asides) {
        const children = a.querySelectorAll('*');
        asideChildren.push({ tag: a.tagName, childCount: children.length, text: (a.textContent||'').trim().substring(0,100) });
      }
      const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(t => t.length > 0 && t.length < 30);
      return JSON.stringify({
        asides: asides.length,
        asideDetails: asideChildren,
        buttonsSample: buttons.slice(0, 15),
        bodyLen: (document.body.textContent||'').length
      }, null, 2);
    })()`)
    console.log('\nAcademics page DOM:')
    console.log(acadInfo)

    // Navigate to classes
    await evalP("location.hash='#/classes'; await new Promise(r=>setTimeout(r,2000));")
    const classInfo = await evalP(`(function(){
      const cards = document.querySelectorAll('[class*="card"]');
      const cardTexts = [];
      for (const c of cards) {
        const t = (c.textContent||'').trim().substring(0,60);
        if (t && t.includes('班')) cardTexts.push(t);
      }
      const divs = document.querySelectorAll('div');
      const classDivs = [];
      for (const d of divs) {
        if (d.children.length === 0) {
          const t = (d.textContent||'').trim();
          if (t.includes('班') && t.length < 50) classDivs.push(t);
        }
      }
      return JSON.stringify({
        cards: cards.length,
        cardTextsSample: cardTexts.slice(0,5),
        classDivsSample: classDivs.slice(0,10),
        bodyLen: (document.body.textContent||'').length,
        bodyStart: (document.body.textContent||'').substring(0,300)
      }, null, 2);
    })()`)
    console.log('\nClasses page DOM:')
    console.log(classInfo)

    ws.close()
    process.exit(0)
  })
})
