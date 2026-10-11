import type { CeremonyStage, CeremonyStatus } from './api';

const STAGE_NAMES: Record<CeremonyStage['key'], string> = {
  tv_power_on: 'TV power',
  tv_input: 'TV input',
  output: 'display selection',
  session: 'Game Mode',
  audio: 'audio',
};

/** A completed ceremony verifies Game Mode, not that a TV is displaying it.
 * Optional failures must name their own stages: a TV pairing error is not an
 * audio failure, and skipped audio is normal on an undocked handheld. */
export function couchModeSummary(
  job: Pick<CeremonyStatus, 'state'> & { stages?: CeremonyStage[] | null },
): string {
  const stages = Array.isArray(job.stages) ? job.stages : [];
  if (job.state === 'running') return 'Switching to Game Mode…';
  if (job.state === 'failed') {
    const fatal = stages.find((stage) => stage.state === 'failed' && stage.fatal);
    return `Couldn't reach Game Mode${fatal?.reason ? ` — ${fatal.reason}` : ''}.`;
  }
  if (job.state !== 'done') return '';

  const failures = stages.filter((stage) => stage.state === 'failed' && !stage.fatal);
  if (failures.length) {
    const names = failures.map((stage) => STAGE_NAMES[stage.key] ?? stage.label);
    const list = names.length === 1 ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const subject = list.charAt(0).toUpperCase() + list.slice(1);
    return `Game Mode is ready. ${subject} ${names.length === 1 ? 'needs' : 'need'} attention. See the details above.`;
  }
  const audio = stages.find((stage) => stage.key === 'audio');
  // Existing agents express this optional outcome in the skip reason.
  if (audio?.state === 'skipped' && audio.reason?.startsWith('no external display')) {
    return 'Game Mode is ready. No external display was detected; audio stays on the box.';
  }
  return 'Game Mode is ready.';
}
