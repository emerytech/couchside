/**
 * Build the argv list for a custom launcher from the Add-launcher form.
 *
 * WHY THIS EXISTS. The form used to be a single "Command" field split on
 * whitespace (`cmd.trim().split(/\s+/)`). That turned a real Windows path like
 * `C:\Program Files\Kodi\kodi.exe` into TWO argv entries
 * (`C:\Program`, `Files\Kodi\kodi.exe`), so the agent's argv-list launch
 * (Popen(argv), shell=False) failed on every spaced path — the single most
 * common case on Windows. The agent stores this argv verbatim and never
 * re-parses it, so the split HAS to be correct here.
 *
 * The fix splits the two concerns: the PROGRAM (argv[0]) is taken verbatim, so
 * spaces in a path are fine; only the optional ARGUMENTS are tokenized, and
 * that tokenizer is quote-aware so `--flag "a b"` stays one argument.
 */

/** Quote-aware tokenizer: a "double" or 'single' quoted run keeps its embedded
 *  spaces as a single token; everything else splits on whitespace. */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** argv[0] = program verbatim (spaces in the path are fine); the rest is the
 *  quote-aware split of the arguments field. Empty program -> empty argv, which
 *  the form treats as "nothing to run". */
export function buildLauncherArgv(program: string, argstr: string): string[] {
  const prog = program.trim();
  if (!prog) return [];
  return [prog, ...parseArgs(argstr.trim())];
}
