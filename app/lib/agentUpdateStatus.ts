/** Pure status mapping shared by the banner and tests; supports older agents. */
export type AgentUpdateStatus = {
  available: boolean;
  installed: string;
  latest: string | null;
  disabled?: boolean;
  error?: string;
};
export function agentUpdateStatusText(status: AgentUpdateStatus | null | undefined): string {
  if (!status) return 'Service updates';
  if (status.disabled) return 'Update checks are off on this PC';
  if (status.error) return 'Could not check for updates';
  return status.available
    ? `Update available — service ${status.latest}`
    : `Up to date — service ${status.installed}`;
}
