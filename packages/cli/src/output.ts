/** Where command output goes, and how a command asks for confirmation. */
export interface Output {
  log(line: string): void
  error(line: string): void
  /**
   * Asks a yes or no question. Absent when nobody can answer (no terminal); commands that need
   * confirmation then refuse unless `--yes` is given.
   */
  confirm?(question: string): Promise<boolean>
}

/** Asks for confirmation unless `yes` is set. Returns whether to proceed, explaining a refusal. */
export async function confirmed(out: Output, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (out.confirm === undefined) {
    out.error("Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.")
    return false
  }
  if (await out.confirm(question)) return true
  out.log("Not applied.")
  return false
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
