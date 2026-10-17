/** Probe a snap-rail feed endpoint for the transport risks an intranet
 * deployment depends on (docs/deploy.md「本地 Gitea 验证」):
 *
 * 1. The feed files arrive byte-identical (index.json digest, zip sha256/size).
 * 2. The responses carry usable headers for electron-updater and the feed
 *    fetch (content-type, content-length, accept-ranges, cache hints).
 * 3. Which raw URL shape this Gitea serves (`/raw/branch/<ref>/` vs the legacy
 *    `/raw/<ref>/` vs `/media/<ref>/`) — a wrong guess looks like a dead feed.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-feed-endpoint.ts --update <desktop-feed-url> [--plugins <plugins-feed-url>]
 *
 * Exit code is non-zero only on hard failures (feed unreachable, digest
 * mismatch); header warnings are reported but do not fail.
 *
 * @module snap-rail/scripts/check-feed-endpoint
 */

interface ProbeResult {
  ok: boolean
  status: number
  contentType: string
  contentLength: string
  headers: Record<string, string>
  bytes?: Uint8Array
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function joinUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, '')}/${file}`
}

async function probe(url: string): Promise<ProbeResult> {
  const response = await fetch(url, { redirect: 'follow' })
  const headers: Record<string, string> = {}
  for (const header of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-disposition']) {
    const value = response.headers.get(header)
    if (value !== null) headers[header] = value
  }
  const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined
  return { ok: response.ok, status: response.status, contentType: response.headers.get('content-type') ?? '', contentLength: response.headers.get('content-length') ?? '', headers, ...(bytes === undefined ? {} : { bytes }) }
}

function report(label: string, url: string, result: ProbeResult): void {
  const status = result.ok ? 'PASS' : `FAIL(${result.status})`
  console.log(`\n[${status}] ${label}\n  ${url}`)
  console.log(`  content-type: ${result.contentType || '(none)'}`)
  console.log(`  content-length: ${result.contentLength || '(none)'}${result.bytes !== undefined ? ` (read ${result.bytes.length} bytes)` : ''}`)
  for (const [header, value] of Object.entries(result.headers)) {
    if (header === 'content-type' || header === 'content-length') continue
    console.log(`  ${header}: ${value}`)
  }
}

/** A wrong raw-shape guess is the most common first-contact failure: when the
 * primary URL 404s, try the alternative Gitea raw routes and report which one
 * the deployment should use instead. */
async function probeWithAlternatives(label: string, url: string): Promise<ProbeResult | undefined> {
  let result = await probe(url)
  if (result.ok) {
    report(label, url, result)
    return result
  }
  console.log(`\n[FAIL(${result.status})] ${label}\n  ${url}`)
  // /raw/branch/<ref>/ ↔ /raw/<ref/ ↔ /media/<ref>/
  const marker = '/raw/branch/'
  const candidates: string[] = []
  if (url.includes(marker)) {
    const [prefix, suffix] = url.split(marker)
    const ref = suffix?.split('/')[0] ?? ''
    const rest = suffix?.slice(ref.length) ?? ''
    candidates.push(`${prefix}/raw/${ref}${rest}`, `${prefix}/media/branch/${ref}${rest}`, `${prefix}/media/${ref}${rest}`)
  } else if (url.includes('/media/')) {
    const [prefix, suffix] = url.split('/media/')
    const ref = suffix?.split('/')[0] ?? ''
    const rest = suffix?.slice(ref.length) ?? ''
    candidates.push(`${prefix}/raw/branch/${ref}${rest}`, `${prefix}/raw/${ref}${rest}`)
  }
  for (const candidate of candidates) {
    const alternative = await probe(candidate)
    if (alternative.ok) {
      console.log(`  ↑ 该 Gitea 不认这个 raw 形状；下面这个可用：\n[PASS] ${label}\n  ${candidate}`)
      report('（同一资源）', candidate, alternative)
      return alternative
    }
  }
  console.log('  ↑ 备选 raw 形状也未命中：检查分支名、仓库路径与 token/权限（私有仓库 raw 需要登录态）。')
  return undefined
}

async function main(): Promise<void> {
  const update = option('--update')
  const plugins = option('--plugins')
  if (update === undefined && plugins === undefined) {
    throw new Error('usage: check-feed-endpoint --update <desktop-feed-url> [--plugins <plugins-feed-url>]')
  }
  let hardFailure = false

  if (update !== undefined) {
    const yml = await probeWithAlternatives('latest.yml（应用更新清单）', joinUrl(update, 'latest.yml'))
    if (yml === undefined || yml.bytes === undefined) {
      hardFailure = true
    } else {
      const text = new TextDecoder().decode(yml.bytes)
      if (!/version:/i.test(text)) {
        console.log('  [WARN] latest.yml 内容不像 electron-builder 清单（缺 version 字段）——确认不是 HTML 错误页伪装 200。')
        hardFailure = true
      }
      const pathMatch = /path:\s*(\S+\.exe)/.exec(text) ?? /url:\s*(\S+\.exe)/.exec(text)
      if (pathMatch !== undefined) {
        const exeUrl = joinUrl(update, pathMatch[1]!)
        // Range 请求探测安装包，避免整包下载。
        const response = await fetch(exeUrl, { headers: { Range: 'bytes=0-0' } })
        await response.body?.cancel()
        const ranged = response.status === 206
        const full = response.status === 200
        console.log(`\n[${response.ok ? 'PASS' : `FAIL(${response.status})`}] 安装包（Range 探测）\n  ${exeUrl}`)
        console.log(`  status: ${response.status}（${ranged ? '支持 Range —— blockmap 差量更新可用' : full ? '不支持 Range —— 只能全量下载，功能可用但差量失效' : '不可用'}）`)
        console.log(`  content-type: ${response.headers.get('content-type') ?? '(none)'}`)
        console.log(`  content-range: ${response.headers.get('content-range') ?? '(none)'}`)
        if (!response.ok) hardFailure = true
      } else {
        console.log('  [WARN] latest.yml 未解析出安装包文件名，跳过 exe 探测。')
      }
    }
  }

  if (plugins !== undefined) {
    const index = await probeWithAlternatives('index.json（插件目录清单）', joinUrl(plugins, 'index.json'))
    if (index === undefined || index.bytes === undefined) {
      hardFailure = true
    } else {
      let catalog: { plugins?: Array<{ name?: string, file?: string, sha256?: string, size?: number }> }
      try {
        catalog = JSON.parse(new TextDecoder().decode(index.bytes)) as typeof catalog
      } catch {
        console.log('  [FAIL] index.json 不是合法 JSON —— 多半是登录页/错误页伪装 200。')
        hardFailure = true
        catalog = {}
      }
      const entries = catalog.plugins ?? []
      console.log(`  条目数: ${entries.length}`)
      const first = entries.find(entry => typeof entry.file === 'string')
      if (first !== undefined && first.sha256 !== undefined && first.size !== undefined) {
        const zip = await probeWithAlternatives(`zip 完整性（${first.name ?? first.file}）`, joinUrl(plugins, first.file))
        if (zip === undefined || zip.bytes === undefined) {
          hardFailure = true
        } else {
          const { createHash } = await import('node:crypto')
          const digest = createHash('sha256').update(zip.bytes).digest('hex')
          if (digest !== first.sha256 || zip.bytes.length !== first.size) {
            console.log(`  [FAIL] 摘要/大小不匹配：feed 声明 ${first.sha256}/${first.size}，实际 ${digest}/${zip.bytes.length}`)
            hardFailure = true
          } else {
            console.log(`  [PASS] sha256 与 size 与清单一致`)
          }
        }
      }
      await probeWithAlternatives('catalog.json（网站目录，可选）', joinUrl(plugins, 'catalog.json'))
    }
  }

  console.log(`\n结论: ${hardFailure ? '存在硬性失败，先修复再指向终端' : '探测通过（注意上方 WARN）'}`)
  if (hardFailure) process.exitCode = 1
}

// Run only when invoked directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-feed-endpoint.ts')) {
  main().catch(cause => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
