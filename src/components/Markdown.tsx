import { Children, isValidElement, memo, useState } from 'react'
import type {
  ComponentProps,
  ComponentPropsWithoutRef,
  ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMarkdown } from '../lib/markdown'
import { ARTIFACT_HREF } from '../lib/parts'
import { ArtifactChip } from './artifacts'
import 'katex/dist/katex.min.css'

const plainText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return plainText(node.props.children)
  }
  return ''
}

const languageOf = (node: ReactNode): string => {
  const [child] = Children.toArray(node)
  if (!isValidElement<{ className?: string }>(child)) return ''
  return /language-([\w+#-]+)/.exec(child.props.className ?? '')?.[1] ?? ''
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(children))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{languageOf(children) || 'text'}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}

// Half-written formulas are normal while tokens stream in, so render them in
// body colour instead of KaTeX's alarming red.
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeKatex, { errorColor: '#26312b' }],
]

function Link({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) {
  const placeholder = ARTIFACT_HREF.exec(href ?? '')
  if (placeholder) {
    return (
      <ArtifactChip
        id={placeholder[1]}
        version={Number(placeholder[2])}
        label={plainText(children)}
      />
    )
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

const components = {
  pre: CodeBlock,
  a: Link,
  table: ({ children, ...props }: ComponentPropsWithoutRef<'table'>) => (
    <div className="table-scroll">
      <table {...props}>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({
  content,
}: {
  content: string
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
})
