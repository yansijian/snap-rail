/**
 * A deliberately small Markdown subset renderer for the website's generated
 * doc pages (`scripts/gen-website-dev-page.ts`). No dependency, deterministic
 * output — and **strict**: anything outside the subset throws instead of
 * being dropped, so a doc edit that the page cannot render fails the gate
 * rather than silently losing content.
 *
 * Blocks: ATX headings (`#`..`####`), fenced code (```lang), pipe tables,
 * blockquotes (`>`), single-level lists (`-` / `1.`), horizontal rules
 * (`---`), paragraphs.
 * Inline: `` `code` ``, `**strong**`, `[label](url)` with http(s)/relative
 * URLs only.
 *
 * @module snap-rail/scripts/lib/markdown
 */

/** One entry of the rendered document's heading tree. */
export interface TocEntry {
  id: string
  text: string
  level: number
}

export interface RenderOptions {
  /** Skip the document's leading `# ` title (the page hero supplies it). */
  skipFirstHeading?: boolean
}

export interface RenderResult {
  html: string
  toc: TocEntry[]
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function assertNoRawHtml(line: string): void {
  if (/<\/?[a-zA-Z][^>]*>/.test(line) || /!\[[^\]]*\]\(/.test(line)) {
    throw new Error(`markdown: 不支持的语法（内嵌 HTML 或图片）——${line.trim().slice(0, 60)}`)
  }
}

function assertUrl(url: string): void {
  if (!/^(?:https?:\/\/|\.\/|\/|#)/.test(url)) {
    throw new Error(`markdown: 链接只允许 http(s)/相对/锚点 —— ${url}`)
  }
}

/** Inline pass over already-escaped text: strong, then links. */
function renderInlineParts(escaped: string): string {
  const linked = escaped.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    assertUrl(url)
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
  })
  return linked.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
}

/** Inline code first (its content is escaped verbatim), then the rest. */
function renderInline(text: string): string {
  return text.split(/(`[^`]+`)/).map(part => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`
    }
    return renderInlineParts(escapeHtml(part))
  }).join('')
}

/** CJK-friendly slug: keep letters/numbers (Chinese included), dash the rest. */
function slugify(text: string, used: Set<string>): string {
  const base = text.toLowerCase().trim().replaceAll(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const stem = base === '' ? 'section' : base
  let id = stem
  let index = 2
  while (used.has(id)) {
    id = `${stem}-${index}`
    index += 1
  }
  used.add(id)
  return id
}

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const used = new Set<string>()
  const toc: TocEntry[] = []
  const out: string[] = []
  let index = 0
  let skippedFirstHeading = false

  const headingOf = (level: number, text: string, skip: boolean): void => {
    if (skip) return
    const id = slugify(text, used)
    toc.push({ id, text, level })
    out.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`)
  }

  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.startsWith('```')) {
        body.push(lines[index]!)
        index += 1
      }
      if (index >= lines.length) throw new Error('markdown: 代码围栏没有闭合')
      index += 1
      out.push(`<pre class="code"><code>${escapeHtml(`${body.join('\n')}\n`)}</code></pre>`)
      continue
    }
    assertNoRawHtml(line)
    const heading = /^(#{1,4}) (.+)$/.exec(line)
    if (heading !== null) {
      const level = heading[1]!.length
      const text = heading[2]!
      const skip = options.skipFirstHeading === true && level === 1 && !skippedFirstHeading
      skippedFirstHeading = skippedFirstHeading || skip
      headingOf(level, text, skip)
      index += 1
      continue
    }
    if (/^-{3,}$/.test(line.trim())) {
      out.push('<hr>')
      index += 1
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (index < lines.length && lines[index]!.startsWith('>')) {
        body.push(lines[index]!.replace(/^>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote><p>${renderInline(body.join(' '))}</p></blockquote>`)
      continue
    }
    const listMatch = /^(?:[-*] |\d+\. )/.test(line)
    if (listMatch) {
      const ordered = /^\d+\. /.test(line)
      const items: string[] = []
      while (index < lines.length && /^(?:[-*] |\d+\. )/.test(lines[index]!)) {
        items.push(`<li>${renderInline(lines[index]!.replace(/^(?:[-*] |\d+\. )/, ''))}</li>`)
        index += 1
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s+(?:[-*] |\d+\. )/.test(line)) {
      throw new Error(`markdown: 不支持嵌套列表 —— ${line.trim().slice(0, 40)}`)
    }
    const next = lines[index + 1]
    if (line.includes('|') && next !== undefined && /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.includes('-')) {
      const cells = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim() !== '') {
        const row = cells(lines[index]!)
        if (row.length !== header.length) {
          throw new Error(`markdown: 表格行列数不一致（${row.length} ≠ ${header.length}）—— ${lines[index]!.trim().slice(0, 50)}`)
        }
        rows.push(row)
        index += 1
      }
      out.push([
        '<table>',
        `<thead><tr>${header.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`,
        `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table>',
      ].join(''))
      continue
    }
    const paragraph: string[] = []
    // A bare `-` here would also match prose that merely starts with a dash
    // (`--flag`), stopping the loop without consuming the line — an infinite
    // loop in the generator. Only real list markers and rules end a paragraph.
    while (index < lines.length && lines[index]!.trim() !== '' && !/^(?:#{1,4} |```|> |- |\* |\d+\. |-{3,}\s*$)/.test(lines[index]!)) {
      assertNoRawHtml(lines[index]!)
      paragraph.push(lines[index]!.trim())
      index += 1
    }
    if (paragraph.length === 0) {
      throw new Error(`markdown: 这一行无法归入任何块（${line.trim().slice(0, 60)}）`)
    }
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
  }

  return { html: out.join('\n'), toc }
}
