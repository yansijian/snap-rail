/**
 * E2E smoke for the packaged renderer UI: open settings, walk every registered
 * page, exercise the appearance controls, and report console exceptions plus a
 * screenshot of each stop.
 *
 * Usage: node scripts/e2e-ui-smoke.mjs [port]
 */

import { writeFile } from 'node:fs/promises'

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
if (page === undefined) throw new Error('no page target')
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId)
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
const snapshot = async name => {
  const data = await evaluate(`document.body.innerText`)
  console.log(`\n=== ${name} ===\n${data}`)
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(`.e2e-${name}.png`, Buffer.from(shot.data, 'base64'))
}

console.log('before:', await evaluate('document.body.innerText'))
await evaluate(`document.querySelector('button[aria-label="设置"]')?.click()`)
await sleep(500)
await snapshot('settings')

const tabs = await evaluate(`[...document.querySelectorAll('.snap-settings-nav-item')].map(el => el.textContent)`)
console.log('settings tabs:', tabs)
for (let index = 0; index < tabs.length; index += 1) {
  await evaluate(`document.querySelectorAll('.snap-settings-nav-item')[${index}]?.click()`)
  await sleep(400)
  await snapshot(`page-${index}-${tabs[index]}`)
}

// Light-mode pass on the appearance page: the theme tabs write `ui.theme`
// and the shell must flip `data-snap-mode` live without errors. Radix tabs
// activate on mousedown, so the probe presses the trigger like a pointer.
const appearanceIndex = tabs.findIndex(label => label?.includes('外观'))
if (appearanceIndex >= 0) {
  await evaluate(`document.querySelectorAll('.snap-settings-nav-item')[${appearanceIndex}]?.click()`)
  await sleep(1200)
  const lightClicked = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('[data-snap-part="tabs.trigger"]')].find(el => el.textContent?.includes('白天'))
    if (trigger === undefined) return false
    trigger.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    trigger.click()
    return true
  })()`)
  await sleep(1200)
  const mode = await evaluate(`document.documentElement.dataset.snapMode`)
  if (!lightClicked) failures.push('appearance: 白天 trigger not found')
  else if (mode !== 'light') failures.push(`appearance: light mode not applied (data-snap-mode=${String(mode)})`)
  console.log('light mode applied:', { lightClicked, mode })
  await snapshot('theme-light')
  await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('[data-snap-part="tabs.trigger"]')].find(el => el.textContent?.includes('黑夜'))
    trigger?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    trigger?.click()
  })()`)
  await sleep(600)
}

const collectConsoleFailures = () => {
  for (const event of events) {
    if (event.method === 'Runtime.exceptionThrown') {
      failures.push(event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      failures.push(event.params.args.map(arg => arg.value ?? arg.description).join(' '))
    }
  }
}
collectConsoleFailures()
console.log('\nFAILURES', failures)
ws.close()