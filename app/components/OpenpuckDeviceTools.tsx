import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api, type OpenpuckLatest } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';
import { comparePuckFirmware, puckCheckMessage, type PuckInfo, type PuckPairPlan } from '@/lib/openpuck';
import { useConfirm } from './ConfirmDialog';

/** Adds device operations inside the existing Utilities card. Firmware selection,
 * download, flash, batch mode and upstream configurator remain in that card. */
export function OpenpuckDeviceTools({ busy, setBusy, latest, afterBootloader }: {
  busy: boolean; setBusy: (value: boolean) => void;
  latest: OpenpuckLatest | null; afterBootloader: () => void;
}) {
  const { settings } = useSettings();
  const t = useTheme(), confirm = useConfirm();
  const [info, setInfo] = useState<PuckInfo | null>(null);
  const [plan, setPlan] = useState<PuckPairPlan | null>(null);
  const [message, setMessage] = useState('Connect your puck to this computer, then inspect it.');
  const epoch = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    epoch.current++; setInfo(null); setPlan(null);
    return () => { epoch.current++; };
  }, [settings]);
  async function run(op: 'inspect' | 'test' | 'prepare_pair' | 'pair' | 'bootloader') {
    if (pending.current || busy || (op !== 'inspect' && !info)) return;
    if (op === 'pair' && !plan) return;
    const turn = epoch.current;
    if ((op === 'pair' || op === 'bootloader') && !await confirm({
      title: op === 'pair' ? 'Pair these devices?' : 'Enter firmware update mode?',
      message: op === 'pair'
        ? `Controller ${plan!.controller_serial} → puck ${plan!.puck_serial}. Keep both connected by USB and close Steam. Other pairings are preserved.`
        : 'The puck will disconnect and appear as NICENANO. Mount it if prompted, then choose Flash receiver or Flash newest in this card.',
      confirmText: op === 'pair' ? 'Pair controller' : 'Enter bootloader',
    })) return;
    if (turn !== epoch.current || pending.current) return;
    pending.current = true; setBusy(true);
    setMessage(op === 'test' ? 'Checking for 10 seconds. Keep the controller on and move its sticks.' : 'Working…');
    try {
      const body = op === 'inspect' ? {} : op === 'pair' ? { confirmation: plan!.confirmation } : { serial: info!.serial };
      const r = await api.openpuckDevice(settings, op, body);
      if (turn !== epoch.current) return;
      if (!r) { setMessage('Update the Couchside service for device information and pairing. Existing flashing remains available.'); return; }
      if (!r.ok) { setPlan(null); if (op === 'inspect' || op === 'test') setInfo(null); setMessage(r.error || 'Operation incomplete.'); return; }
      if (op === 'inspect') { setInfo(r as PuckInfo); setPlan(null); setMessage('Live snapshot read. Inspect again to refresh.'); }
      else if (op === 'prepare_pair') { setPlan(r as PuckPairPlan); setMessage(`Ready: ${r.controller_serial} → ${r.puck_serial}. Puck slot ${r.puck_slot}; controller slot ${r.controller_slot}. Confirm within ${r.expires_in} seconds.`); }
      else if (op === 'test') setMessage(puckCheckMessage(r));
      else { setPlan(null); setInfo(null); setMessage(r.message || 'Complete.'); if (op === 'bootloader') afterBootloader(); }
    } catch { if (turn === epoch.current) { setPlan(null); setInfo(null); setMessage('Could not confirm completion. Reconnect and inspect before retrying; no pass recorded.'); } }
    finally { pending.current = false; if (turn === epoch.current) setBusy(false); }
  }
  const button = (label: string, op: Parameters<typeof run>[0], disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => void run(op)}
      disabled={busy || disabled} style={{ padding: 10, marginTop: 6, borderWidth: 1, borderRadius: 8,
        borderColor: t.blue, opacity: busy || disabled ? .5 : 1 }}>
      <Text style={{ color: t.blue }}>{label}</Text>
    </Pressable>
  );
  const comparison = info && latest?.available && latest.tag ? comparePuckFirmware(info.build, latest.tag, info.dirty) : null;
  return <View testID="openpuck-device-tools" style={{ marginTop: 12 }}>
    {button('Inspect puck', 'inspect')}
    {info && <>
      <Text style={{ color: t.text, marginTop: 8 }}>Firmware {info.build}{info.dirty ? ' (modified)' : ''} · Protocol {info.protocol}</Text>
      <Text selectable style={{ color: t.textFaint }}>Puck {info.serial} · {info.new_reports} new reports/s</Text>
      {info.slots.map(slot => <Text key={slot.slot} style={{ color: t.textFaint }}>Slot {slot.slot}: {slot.connected ? 'Online' : 'Offline'}{slot.connected && slot.battery != null ? ` · ${slot.battery}%` : ''}{slot.connected && slot.rssi != null ? ` · ${slot.rssi} dBm` : ''}</Text>)}
      {comparison && <Text style={{ color: t.text }}>{comparison === 'current' ? 'Firmware is up to date.' : comparison === 'older' ? `Update available: ${latest!.tag}. Enter bootloader, then choose firmware below.` : comparison === 'newer' ? 'This puck is newer than the release. No downgrade needed.' : 'Custom or unrecognized build; update need cannot be determined.'}</Text>}
      {button('Run connection check', 'test')}
      <Text style={{ color: t.textFaint, marginTop: 8 }}>For pairing, connect the powered-on controller by USB to the same computer and close Steam.</Text>
      {button('Find USB controller', 'prepare_pair')}
      {plan && button('Pair controller', 'pair')}
      {button('Enter bootloader for update or reinstall', 'bootloader')}
    </>}
    <Text accessibilityLiveRegion="polite" style={{ color: t.textFaint, marginTop: 8 }}>{message}</Text>
  </View>;
}
