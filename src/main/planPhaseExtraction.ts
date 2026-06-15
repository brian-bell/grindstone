import { ArtifactStoreError } from './artifactStore'

export type ImplementationPhaseDraft = {
  idBase: string
  title: string
  order: number
  notes?: string
}

type Heading = {
  lineIndex: number
  level: number
  text: string
}

const PREFERRED_SECTION_TITLES = new Set(['implementation phases', 'implementation slices', 'phases'])

export function extractImplementationPhaseDrafts(markdown: string): ImplementationPhaseDraft[] {
  const lines = maskFencedCode(markdown.split(/\r?\n/))
  const headings = findHeadings(lines)
  const preferred = headings.find((heading) =>
    PREFERRED_SECTION_TITLES.has(normalizeHeading(heading.text))
  )

  const drafts = preferred === undefined
    ? []
    : extractListDrafts(lines, preferred, nextSectionLine(headings, preferred, lines.length))

  const fallbackDrafts = drafts.length > 0
    ? drafts
    : extractNumberedHeadingDrafts(lines, headings)

  if (fallbackDrafts.length === 0) {
    throw new ArtifactStoreError(
      'validation_error',
      'Linked plan does not contain supported implementation phases.'
    )
  }

  return assignStableIds(fallbackDrafts)
}

function extractListDrafts(
  lines: string[],
  heading: Heading,
  endLine: number
): Array<Omit<ImplementationPhaseDraft, 'idBase'>> {
  const candidates: Array<{
    lineIndex: number
    indent: number
    title: string
  }> = []

  for (let index = heading.lineIndex + 1; index < endLine; index += 1) {
    const match = /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(lines[index] ?? '')
    if (match === null) {
      continue
    }
    const title = cleanTitle(match[2])
    if (title !== '') {
      candidates.push({ lineIndex: index, indent: match[1].length, title })
    }
  }

  if (candidates.length === 0) {
    return []
  }

  const siblingIndent = Math.min(...candidates.map((candidate) => candidate.indent))
  const drafts: Array<Omit<ImplementationPhaseDraft, 'idBase'>> = []
  let current: { title: string; notes: string[] } | undefined

  for (let index = heading.lineIndex + 1; index < endLine; index += 1) {
    const line = lines[index] ?? ''
    const match = /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line)
    if (match !== null && match[1].length === siblingIndent) {
      if (current !== undefined) {
        drafts.push(toDraft(current, drafts.length + 1))
      }
      current = { title: cleanTitle(match[2]), notes: [] }
      continue
    }

    if (current !== undefined && line.trim() !== '') {
      current.notes.push(stripNestedMarker(line))
    }
  }

  if (current !== undefined) {
    drafts.push(toDraft(current, drafts.length + 1))
  }

  return drafts
}

function extractNumberedHeadingDrafts(
  lines: string[],
  headings: Heading[]
): Array<Omit<ImplementationPhaseDraft, 'idBase'>> {
  const section = headings.find((heading) =>
    normalizeHeading(heading.text) === 'implementation slices'
  )
  if (section === undefined) {
    return []
  }

  const endLine = nextSectionLine(headings, section, lines.length)
  const childHeadings = headings.filter((heading) =>
    heading.lineIndex > section.lineIndex &&
    heading.lineIndex < endLine &&
    heading.level === section.level + 1 &&
    /^\d+[.)]\s+/.test(heading.text.trim())
  )

  return childHeadings.map((heading, index) => {
    const nextHeading = childHeadings[index + 1]
    const notesEnd = nextHeading?.lineIndex ?? endLine
    const notes = lines
      .slice(heading.lineIndex + 1, notesEnd)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
    return {
      title: cleanTitle(heading.text.replace(/^\d+[.)]\s+/, '')),
      order: index + 1,
      notes: notes === '' ? undefined : notes
    }
  }).filter((draft) => draft.title !== '')
}

function toDraft(
  current: { title: string; notes: string[] },
  order: number
): Omit<ImplementationPhaseDraft, 'idBase'> {
  const notes = current.notes
    .map((note) => note.trim())
    .filter(Boolean)
    .join('\n')
  return {
    title: current.title,
    order,
    notes: notes === '' ? undefined : notes
  }
}

function assignStableIds(
  drafts: Array<Omit<ImplementationPhaseDraft, 'idBase'>>
): ImplementationPhaseDraft[] {
  const counts = new Map<string, number>()
  return drafts.map((draft) => {
    const base = slugifyPhaseTitle(draft.title)
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    return {
      ...draft,
      idBase: count === 0 ? base : `${base}-${count + 1}`
    }
  })
}

function findHeadings(lines: string[]): Heading[] {
  return lines.flatMap((line, lineIndex): Heading[] => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match === null) {
      return []
    }
    return [{ lineIndex, level: match[1].length, text: cleanTitle(match[2]) }]
  })
}

function nextSectionLine(headings: Heading[], heading: Heading, fallback: number): number {
  return headings.find((candidate) =>
    candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level
  )?.lineIndex ?? fallback
}

function maskFencedCode(lines: string[]): string[] {
  let inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return ''
    }
    return inFence ? '' : line
  })
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stripNestedMarker(value: string): string {
  return value
    .trim()
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\d+[.)]\s+/, '')
}

function cleanTitle(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function slugifyPhaseTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'phase'
}
