/**
 * System — the ops dashboard (CPU temp, vitals, memory, disks, LEDs, screen,
 * gaming, units, file drop) as its OWN tab. PROTOTYPE ONLY: the reco Home takes
 * the landing (index) tab there, so the box-status dashboard that used to be the
 * front page moves here rather than disappearing. In production this tab is hidden
 * (the layout gives it a null href) and the same content stays on the index tab.
 *
 * It renders the exact ConsoleScreen exported from the index route — one source of
 * truth, so the ops dashboard can never drift between the two placements.
 */
import { Gated } from '@/components/Gated';
import { TabScreen } from '@/components/TabScreen';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { ConsoleScreen } from './index';

export default function SystemTab() {
  useLockOrientation('portrait');
  return (
    <TabScreen>
      <Gated>
        <ConsoleScreen />
      </Gated>
    </TabScreen>
  );
}
