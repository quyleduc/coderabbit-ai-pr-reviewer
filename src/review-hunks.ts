import type {CoverageStatus} from './review-integrity'
import type {ChangedLineIndex} from './diff-hunks'

/** File/hunk-local IDs exist only for the current immutable review scope. */
export function hunkUnitId(path: string, index: number): string {
  if (!path || !Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('Invalid hunk unit')
  }
  return JSON.stringify([path, index])
}

/**
 * Hunk-level accounting: model feedback must explicitly acknowledge EACH
 * packed hunk. A response about one hunk never completes a second hunk.
 */
export class HunkCoverage {
  private readonly statuses = new Map<string, CoverageStatus>()
  private readonly counts = new Map<string, number>()

  registerFile(path: string, count: number): void {
    if (!path || !Number.isSafeInteger(count) || count < 1 || this.counts.has(path)) {
      throw new TypeError('Expected a new path with at least one hunk')
    }
    this.counts.set(path, count)
    for (let i = 0; i < count; i++) this.statuses.set(hunkUnitId(path, i), 'pending')
  }

  mark(path: string, index: number, status: CoverageStatus): void {
    const id = hunkUnitId(path, index)
    if (!this.statuses.has(id)) throw new RangeError('Unregistered review hunk')
    // A failed unit cannot be turned into a success by later model output.
    const prev = this.statuses.get(id)
    if (prev === 'failed_analysis' || prev === 'failed_publish') return
    if (prev === 'blocked_by_budget' && status === 'reviewed') return
    this.statuses.set(id, status)
  }

  markFile(path: string, status: CoverageStatus): void {
    const n = this.counts.get(path)
    if (n === undefined) throw new RangeError('Unregistered review file')
    for (let i = 0; i < n; i++) this.mark(path, i, status)
  }

  markPacked(path: string, packed: number): void {
    const n = this.counts.get(path)
    if (n === undefined || !Number.isSafeInteger(packed) || packed < 0 || packed > n) {
      throw new RangeError('Invalid packed hunk count')
    }
    for (let i = packed; i < n; i++) this.mark(path, i, 'blocked_by_budget')
  }

  markUnacknowledged(path: string, packed: number): void {
    const n = this.counts.get(path)
    if (n === undefined || !Number.isSafeInteger(packed) || packed < 0 || packed > n) {
      throw new RangeError('Invalid packed hunk count')
    }
    for (let i = 0; i < packed; i++) {
      if (this.statuses.get(hunkUnitId(path, i)) === 'pending') {
        this.mark(path, i, 'failed_analysis')
      }
    }
  }

  snapshot() {
    const expectedIds = [...this.statuses.keys()]
    const entries = [...this.statuses].map(([id, status]) => ({id, status}))
    return {expectedIds, entries}
  }

  get(path: string, index: number): CoverageStatus | undefined {
    return this.statuses.get(hunkUnitId(path, index))
  }

  get size(): number {
    return this.statuses.size
  }
}

/** Map a model range to one original hunk. Never remap it across hunks. */
export function hunkIndexForRange(
  index: ChangedLineIndex,
  startLine: number,
  endLine: number
): number | null {
  if (!index.valid || !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return null
  }
  const found = index.hunks.findIndex(
    hunk => startLine >= hunk.startLine && endLine <= hunk.endLine
  )
  return found < 0 ? null : found
}
