/**
 * Layout probe: connect over CDP and dump the computed layout of the
 * floating-ball switch row on the appearance page (label-below-switch bug).
 *
 * Usage: node scripts/e2e-layout-probe.mjs [port]
 */

const port = process.argv[2] ?? '9223'
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

function send(method, params = {}, sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
}

const { targetInfos } = await send('Target.getTargets')
const page = targetInfos.find(target => target.type === 'page')
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)

const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

// Open settings and stop on the appearance page.
const openState = await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.snap-settings-nav-item')]
  const target = nav.find(el => el.textContent?.includes('外观与显示'))
  if (target === undefined) return { nav: nav.map(el => el.textContent), body: document.body.innerText.slice(0, 200) }
  target.click()
  return { clicked: true }
})()`)
console.log('open:', JSON.stringify(openState))
await new Promise(resolve => setTimeout(resolve, 600))

const report = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('label.snap-switch-label')].map(el => {
    const parent = el.parentElement
    const ps = parent ? getComputedStyle(parent) : null
    const ls = getComputedStyle(el)
    const pr = parent?.getBoundingClientRect()
    const lr = el.getBoundingClientRect()
    return {
      switchText: el.textContent,
      parentTag: parent?.tagName,
      parentClass: parent?.className,
      parentAttrStyle: parent?.getAttribute('style'),
      parentDisplay: ps ? ps.display + '/' + ps.flexDirection : null,
      labelDisplay: ls.display + '/' + ls.flexDirection,
      parentRect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
      labelRect: { x: lr.x, y: lr.y, w: lr.width, h: lr.height },
      parentHtml: parent?.innerHTML.slice(0, 300),
    }
  })
  return rows
})()`)
console.log(JSON.stringify(report, null, 2))
ws.close()
