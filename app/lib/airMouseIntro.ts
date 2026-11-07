/** An update tip for an already-configured installation, never a fresh-install interruption. */
export function airMouseIntroState(args: {
  ready: boolean; done: boolean; boxCount: number; tvCount: number;
}): 'wait' | 'done' | 'fresh' | 'offer' {
  if (!args.ready) return 'wait';
  if (args.done) return 'done';
  return args.boxCount > 0 || args.tvCount > 0 ? 'offer' : 'fresh';
}
