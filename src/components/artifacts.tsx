import { useContext, useEffect, useId, useState } from 'react'
import { fetchArtifact } from '../api/agent'
import { ArtifactContext, type OpenArtifact } from '../lib/artifactContext'
import type { Artifact } from '../types'
import { Markdown } from './Markdown'

const KIND_LABEL: Record<Artifact['kind'], string> = {
  markdown: 'Document',
  code: 'Code',
  html: 'Web page',
  svg: 'Image',
  mermaid: 'Diagram',
  text: 'Text',
}

const EXTENSION: Record<Artifact['kind'], string> = {
  markdown: 'md',
  code: 'txt',
  html: 'html',
  svg: 'svg',
  mermaid: 'mmd',
  text: 'txt',
}

const CODE_EXTENSION: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  bash: 'sh',
  shell: 'sh',
  json: 'json',
  yaml: 'yaml',
  rust: 'rs',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  sql: 'sql',
}

const useArtifact = (id: string, version?: number) => {
  const [state, setState] = useState<{
    key: string
    artifact?: Artifact
    error?: string
  }>({ key: '' })
  const key = `${id}/${version ?? ''}`

  useEffect(() => {
    let active = true
    fetchArtifact(id, version).then(
      (artifact) => active && setState({ key, artifact }),
      (caught: unknown) =>
        active &&
        setState({
          key,
          error: caught instanceof Error ? caught.message : 'Not found',
        }),
    )
    return () => {
      active = false
    }
  }, [id, version, key])

  return state.key === key ? state : { key }
}

/** What an artifact placeholder in the answer renders as. */
export function ArtifactChip({
  id,
  version,
  label,
}: {
  id: string
  version: number
  label: string
}) {
  const { open, current } = useContext(ArtifactContext)
  const { artifact, error } = useArtifact(id, version)
  const isOpen = current?.id === id && current.version === version

  return (
    <button
      type="button"
      className={`artifact-chip ${isOpen ? 'is-open' : ''}`}
      onClick={() => open({ id, version })}
      disabled={Boolean(error)}
    >
      <span className="artifact-chip-icon" aria-hidden="true">
        {artifact?.kind === 'code' ? '</>' : artifact?.kind === 'html' ? '◧' : '▤'}
      </span>
      <span className="artifact-chip-text">
        <strong>{artifact?.title ?? label}</strong>
        <small>
          {error
            ? 'Artifact not found'
            : artifact
              ? `${KIND_LABEL[artifact.kind]}${artifact.language ? ` · ${artifact.language}` : ''} · version ${version}`
              : 'Loading…'}
        </small>
      </span>
    </button>
  )
}

function MermaidView({ source }: { source: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const id = useId().replace(/[^\w]/g, '')

  useEffect(() => {
    let active = true
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        // Plain SVG labels: an <img> does not lay out HTML labels reliably.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          flowchart: { htmlLabels: false },
        })
        const rendered = await mermaid.render(`mermaid${id}`, source)
        if (active) {
          setSvg(rendered.svg)
          setError('')
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : 'Could not render the diagram.')
        }
      })
    return () => {
      active = false
    }
  }, [id, source])

  if (error) return <pre className="artifact-source">{`${error}\n\n${source}`}</pre>
  return (
    <img
      className="artifact-image"
      alt="Diagram"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    />
  )
}

function ArtifactBody({ artifact, showSource }: { artifact: Artifact; showSource: boolean }) {
  if (showSource || artifact.kind === 'code' || artifact.kind === 'text') {
    return <pre className="artifact-source">{artifact.content}</pre>
  }
  if (artifact.kind === 'markdown') {
    return (
      <div className="artifact-document">
        <Markdown content={artifact.content} />
      </div>
    )
  }
  if (artifact.kind === 'html') {
    // No allow-same-origin: the page's scripts run, but cannot reach this app.
    return (
      <iframe
        className="artifact-frame"
        title={artifact.title}
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={artifact.content}
      />
    )
  }
  if (artifact.kind === 'svg') {
    return (
      <img
        className="artifact-image"
        alt={artifact.title}
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`}
      />
    )
  }
  return <MermaidView source={artifact.content} />
}

const fileName = (artifact: Artifact) => {
  const base = artifact.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact'
  const extension =
    artifact.kind === 'code'
      ? (CODE_EXTENSION[artifact.language] ?? (artifact.language || 'txt'))
      : EXTENSION[artifact.kind]
  return base.includes('.') ? base : `${base}.${extension}`
}

export function ArtifactPanel({
  artifact: selected,
  onSelect,
  onClose,
}: {
  artifact: OpenArtifact
  onSelect: (artifact: OpenArtifact) => void
  onClose: () => void
}) {
  const { artifact, error } = useArtifact(selected.id, selected.version)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const renderable =
    artifact && !['code', 'text'].includes(artifact.kind)

  const copy = async () => {
    if (!artifact) return
    try {
      await navigator.clipboard.writeText(artifact.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const download = () => {
    if (!artifact) return
    const url = URL.createObjectURL(new Blob([artifact.content], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName(artifact)
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside className="artifact-panel" aria-label="Artifact">
      <header className="artifact-panel-head">
        <div>
          <p className="eyebrow">{artifact ? KIND_LABEL[artifact.kind] : 'Artifact'}</p>
          <h2>{artifact?.title ?? (error ? 'Not found' : 'Loading…')}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close artifact"
        >
          ×
        </button>
      </header>
      {artifact ? (
        <div className="artifact-toolbar">
          {artifact.latest_version > 1 ? (
            <select
              aria-label="Version"
              value={selected.version}
              onChange={(event) =>
                onSelect({ id: selected.id, version: Number(event.target.value) })
              }
            >
              {Array.from({ length: artifact.latest_version }, (_, index) => index + 1).map(
                (version) => (
                  <option key={version} value={version}>
                    Version {version}
                    {version === artifact.latest_version ? ' (latest)' : ''}
                  </option>
                ),
              )}
            </select>
          ) : null}
          {renderable ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowSource((value) => !value)}
            >
              {showSource ? 'Preview' : 'Source'}
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="secondary-button" onClick={download}>
            Download
          </button>
        </div>
      ) : null}
      <div className="artifact-panel-body">
        {artifact ? (
          <ArtifactBody artifact={artifact} showSource={showSource} />
        ) : error ? (
          <p className="artifact-empty">{error}</p>
        ) : (
          <p className="artifact-empty">Loading…</p>
        )}
      </div>
    </aside>
  )
}
