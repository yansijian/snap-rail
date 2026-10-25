/**
 * E2E probe for the packaged renderer: connect over CDP, report every target,
 * dump the page's DOM/computed theme state, and replay console/exception
 * entries captured while the page was booting.
 *
 * Usage: node scripts/e2e-black-screen.mjs [port]
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

await send('Target.setDiscoverTargets', { discover: true })
const { targetInfos } = await send('Target.getTargets')
console.log('TARGETS', JSON.stringify(targetInfos, null, 2))

const page = targetInfos.find(target => target.type === 'page')
if (page === undefined) {
  console.log('NO PAGE TARGET')
  process.exit(0)
}

const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Log.enable', {}, sessionId)
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId)
  return result.result
}

console.log('DOM', JSON.stringify(await evaluate(`({
  readyState: document.readyState,
  bodyText: document.body?.innerText?.slice(0, 500),
  rootHtml: document.getElementById('root')?.innerHTML.slice(0, 1000),
  skin: document.documentElement.dataset.snapSkin,
  mode: document.documentElement.dataset.snapMode,
  bg: getComputedStyle(document.body).backgroundColor,
  color: getComputedStyle(document.body).color,
  vars: {
    bg: getComputedStyle(document.documentElement).getPropertyValue('--snap-color-bg'),
    text: getComputedStyle(document.documentElement).getPropertyValue('--snap-color-text'),
  },
  sheets: [...document.styleSheets].map(sheet => ({ href: sheet.href, rules: (() => { try { return sheet.cssRules.length } catch { return -1 } })() })),
})`), null, 2))

console.log('EVENTS')
for (const event of events) {
  if (event.method === 'Runtime.consoleAPICalled') {
    console.log('console', event.params.type, event.params.args.map(arg => arg.value ?? arg.description).join(' '))
  } else if (event.method === 'Runtime.exceptionThrown') {
    console.log('exception', event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
  } else if (event.method === 'Log.entryAdded') {
    console.log('log', event.params.entry.level, event.params.entry.text)
  }
}

ws.close()