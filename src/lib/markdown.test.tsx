import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../components/Markdown'
import { normalizeMarkdown } from './markdown'

const parenDelimited = `Here are the key components of the hypothesis:

*   **The Riemann Zeta Function**:
    The function is defined for complex numbers \\( s \\) with real part greater than 1 by the series:
    \\[
    \\zeta(s) = \\sum_{n=1}^{\\infty} \\frac{1}{n^s}
    \\]
    This function can be analytically continued to the entire complex plane, except for a simple pole at \\( s = 1 \\).

*   **The Hypothesis Statement**:
    If \\( \\zeta(s) = 0 \\) and \\( s \\) is not a negative even integer, then:
    \\[
    \\text{Re}(s) = \\frac{1}{2}
    \\]
`

describe('normalizeMarkdown', () => {
  it('turns \\( \\) and \\[ \\] into dollar math and undents list continuations', () => {
    const normalized = normalizeMarkdown(parenDelimited)

    expect(normalized).toContain('$s$')
    expect(normalized).toContain('$\\zeta(s) = 0$')
    expect(normalized).toContain(
      '$$\n\\zeta(s) = \\sum_{n=1}^{\\infty} \\frac{1}{n^s}\n$$',
    )
    expect(normalized).not.toContain('\\[')
    expect(normalized).not.toContain('\\(')
    expect(normalized).not.toMatch(/^ {4}/m)
  })

  it('promotes one-line $$ formulas to display blocks', () => {
    expect(normalizeMarkdown('See $$ \\zeta(s) = 1 $$ next.')).toContain(
      '$$\n\\zeta(s) = 1\n$$',
    )
  })

  it('leaves fenced code untouched', () => {
    const source = '```tex\n\\[ raw \\]\n```'
    expect(normalizeMarkdown(source)).toBe(source)
  })
})

describe('Markdown', () => {
  it('renders Qwen-style math as KaTeX instead of raw TeX', () => {
    const { container } = render(<Markdown content={parenDelimited} />)

    expect(container.querySelectorAll('.katex').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.katex-display').length).toBeGreaterThan(
      0,
    )
    expect(container.querySelector('.markdown')?.innerHTML).not.toContain('\\[')
    expect(screen.getByText('The Riemann Zeta Function')).toBeInTheDocument()
  })
})
