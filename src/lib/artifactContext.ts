import { createContext } from 'react'

export interface OpenArtifact {
  id: string
  version: number
}

export const ArtifactContext = createContext<{
  open: (artifact: OpenArtifact) => void
  current: OpenArtifact | null
}>({ open: () => {}, current: null })
