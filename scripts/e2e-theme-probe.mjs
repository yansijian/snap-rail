/**
 * Theme interaction probe: click 白天 on the appearance page, then report the
 * resulting `data-snap-mode`, computed background, and the settings.readback.
 *
 * Usage: node scripts/e2e-theme-probe.mjs [port]
 */

const port = process.argv[2] ?? '9223'
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const events = []

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  } else if (message.method !== undefined) {
    events.push(message)
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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const open = await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.snap-settings-nav-item')]
  nav.find(el => el.textContent?.includes('外观与显示'))?.click()
  const triggers = [...document.querySelectorAll('[data-snap-part="tabs.trigger"]')]
  return { navCount: nav.length, triggerTexts: triggers.map(el => el.textContent), activeTab: triggers.find(el => el.getAttribute('aria-selected') === 'true')?.textContent }
})()`)
console.log('open:', JSON.stringify(open))

// Let the page's initial settings reads settle before clicking — the readback
// must not race the optimistic update we are about to test.
await new Promise(resolve => setTimeout(resolve, 2500))

const before = await evaluate(`({
  mode: document.documentElement.dataset.snapMode,
  bg: getComputedStyle(document.body).backgroundColor,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
})`)
console.log('before:', JSON.stringify(before))

const clicked = await evaluate(`(() => {
  const trigger = [...document.querySelectorAll('[data-snap-part="tabs.trigger"]')].find(el => el.textContent?.includes('白天'))
  if (trigger === undefined) return { found: false }
  // Radix tabs activate on mousedown, not click — synthesize the press.
  trigger.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
  trigger.click()
  return { found: true, selected: trigger.getAttribute('aria-selected') }
})()`)
console.log('click:', JSON.stringify(clicked))

await new Promise(resolve => setTimeout(resolve, 1500))

const after = await evaluate(`({
  mode: document.documentElement.dataset.snapMode,
  bg: getComputedStyle(document.body).backgroundColor,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  selected: [...document.querySelectorAll('[data-snap-part="tabs.trigger"]')].find(el => el.getAttribute('aria-selected') === 'true')?.textContent,
  alert: document.querySelector('[role="alert"]')?.textContent ?? null,
})`)
console.log('after:', JSON.stringify(after))

for (const event of events) {
  if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params.type)) {
    console.log('console', event.params.type, event.params.args.map(arg => arg.value ?? arg.description).join(' ').slice(0, 300))
  } else if (event.method === 'Runtime.exceptionThrown') {
    console.log('exception', event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
  }
}
ws.close()
