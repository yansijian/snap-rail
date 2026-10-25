/**
 * Scroll/geometry probe: dump the appearance page's scroll state and capture
 * a fresh screenshot plus the ball-section bounding boxes.
 *
 * Usage: node scripts/e2e-scroll-probe.mjs [port]
 */

import { writeFile } from 'node:fs/promises'

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
await send('Page.enable', {}, sessionId)

const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const info = await evaluate(`(() => {
  const scrolled = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 100)
    .map(el => ({ cls: el.className.slice?.(0, 60) ?? el.tagName, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  const sections = [...document.querySelectorAll('section')].map(el => {
    const r = el.getBoundingClientRect()
    const title = el.querySelector('[data-snap-part="section.title"]')?.textContent
    return { title, y: Math.round(r.y), h: Math.round(r.height) }
  })
  const ballRow = [...document.querySelectorAll('label.snap-switch-label')].map(el => {
    const r = el.getBoundingClientRect()
    const div = el.parentElement.getBoundingClientRect()
    return { switchY: Math.round(r.y), switchX: Math.round(r.x), divW: Math.round(div.width), divH: Math.round(div.height), divStyle: el.parentElement.getAttribute('style') }
  })
  return { dpr: window.devicePixelRatio, innerSize: [window.innerWidth, window.innerHeight], scrolled, sections, ballRow, docScroll: [window.scrollX, window.scrollY] }
})()`)
console.log(JSON.stringify(info, null, 2))

const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
await writeFile('.e2e-now-appearance.png', Buffer.from(shot.data, 'base64'))
ws.close()
