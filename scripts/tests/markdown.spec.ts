import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../lib/markdown.ts'

describe('markdown subset renderer', () => {
  it('renders headings with stable CJK slugs and a TOC', () => {
    const { html, toc } = renderMarkdown('## 签名与信任\n\n正文。\n\n### 子标题\n\n正文。')
    expect(html).toContain('<h2 id="签名与信任">')
    expect(html).toContain('<h3 id="子标题">')
    expect(toc).toEqual([
      { id: '签名与信任', text: '签名与信任', level: 2 },
      { id: '子标题', text: '子标题', level: 3 },
    ])
  })

  it('dedupes slug collisions', () => {
    const { html } = renderMarkdown('## 安装\n\nx\n\n## 安装\n\ny')
    expect(html).toContain('id="安装"')
    expect(html).toContain('id="安装-2"')
  })

  it('renders fenced code escaped, inside the site code class', () => {
    const { html } = renderMarkdown('```sh\npnpm dlx @snap-rail/plugin-sdk init <b>&</b>\n```')
    expect(html).toContain('<pre class="code"><code>')
    expect(html).toContain('init &lt;b&gt;&amp;&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('renders pipe tables with aligned columns', () => {
    const { html } = renderMarkdown('| 模板 | 面 |\n| --- | --- |\n| driver | 宿主 |\n')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>模板</th>')
    expect(html).toContain('<td>宿主</td>')
  })

  it('renders inline code, bold, and safe links', () => {
    const { html } = renderMarkdown('**加粗** 与 `code` 与 [官网](https://www.snap-rail.top/)')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://www.snap-rail.top/" target="_blank" rel="noopener">官网</a>')
  })

  it('renders single-level lists and blockquotes', () => {
    const { html } = renderMarkdown('- 一\n- 二\n\n> 引用一行')
    expect(html).toContain('<ul><li>一</li><li>二</li></ul>')
    expect(html).toContain('<blockquote><p>引用一行</p></blockquote>')
  })

  it('skips the leading h1 for page heroes when asked', () => {
    const { html, toc } = renderMarkdown('# 标题\n\n正文', { skipFirstHeading: true })
    expect(html).not.toContain('<h1')
    expect(toc).toEqual([])
    expect(html).toContain('<p>正文</p>')
  })

  it('throws on out-of-subset syntax instead of dropping it', () => {
    expect(() => renderMarkdown('![截图](x.png)')).toThrow(/图片/)
    expect(() => renderMarkdown('<div>html</div>')).toThrow(/HTML/)
    expect(() => renderMarkdown('- 一\n  - 嵌套')).toThrow(/嵌套/)
    expect(() => renderMarkdown('```sh\n没有闭合')).toThrow(/闭合/)
    expect(() => renderMarkdown('[x](javascript:alert(1))')).toThrow(/链接/)
  })

  it('is deterministic — the same source renders byte-identical output', () => {
    const source = '# 文档\n\n段落一。\n\n```sh\npnpm build\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    expect(renderMarkdown(source)).toEqual(renderMarkdown(source))
  })
})
