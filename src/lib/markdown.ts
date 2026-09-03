/**
 * Chat models rarely emit textbook CommonMark. This pass makes the usual
 * Qwen/vLLM quirks parse as the author intended before react-markdown sees them.
 */
export const normalizeMarkdown = (source: string): string => {
  let text = source.replace(/\r\n/g, '\n')

  const fences: string[] = []
  text = text.replace(/```[\s\S]*?```/g, (block) => {
    fences.push(block)
    return `\u0000FENCE${fences.length - 1}\u0000`
  })

  // Four-space indents are code in CommonMark. Models use them as list
  // continuations, which hid formulas and left a colon sitting on its own line.
  text = text.replace(/^(?: {4}|\t)(?!```)(.*)$/gm, '  $1')

  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => {
    return `\n\n$$\n${body.trim()}\n$$\n\n`
  })
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => {
    return `$${body.trim()}$`
  })

  // One-line $$...$$ is treated as inline math; force a display block.
  text = text.replace(/\$\$([^\n]+?)\$\$/g, (_, body: string) => {
    return `\n\n$$\n${body.trim()}\n$$\n\n`
  })

  // remark-math ignores `$ foo $` when there is a space after the opener.
  text = text.replace(
    /(^|[^$])\$[ \t]+([^$\n]+?)[ \t]+\$($|[^$])/g,
    (_, pre: string, body: string, post: string) => `${pre}$${body.trim()}$${post}`,
  )

  text = text.replace(
    /(?:^|\n)[ \t]*(\\begin\{(align\*?|equation\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\2\})/g,
    (match, env: string, _name: string, offset: number) => {
      const before = text.slice(0, offset)
      if (/\$\$\s*$/.test(before)) return match
      return `\n\n$$\n${env.trim()}\n$$\n\n`
    },
  )

  text = text.replace(/\n{3,}/g, '\n\n')
  // NUL sentinels mark fenced blocks we stashed before rewriting math.
  // oxlint-disable-next-line eslint/no-control-regex
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_, index: string) => {
    return fences[Number(index)] ?? ''
  })

  return text.trim()
}
